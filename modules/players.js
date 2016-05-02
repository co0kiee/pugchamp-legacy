'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const humanize = require('humanize');
const math = require('mathjs');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const ONE_DEVIATION_LOWER_BOUND = 0.16;
    const ONE_DEVIATION_UPPER_BOUND = 0.84;

    function calculatePredictionInterval(samples) {
        let n = _.size(samples);

        if (n > 1) {
            let mean = math.mean(samples);
            let deviation = math.std(samples);

            let distribution = new distributions.Studentt(n - 1);

            let low = mean + (distribution.inv(ONE_DEVIATION_LOWER_BOUND) * deviation * math.sqrt(1 + (1 / n)));
            let high = mean + (distribution.inv(ONE_DEVIATION_UPPER_BOUND) * deviation * math.sqrt(1 + (1 / n)));

            return {
                low,
                center: mean,
                high
            };
        }
        else if (n === 1) {
            let mean = math.mean(samples);

            return {
                low: null,
                center: mean,
                high: null
            };
        }
        else {
            return {
                low: null,
                center: null,
                high: null
            };
        }
    }

    const DRAFT_ORDER = config.get('app.draft.order');
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const RESTRICTION_DURATIONS = config.get('app.users.restrictionDurations');
    const ROLES = config.get('app.games.roles');
    const UPDATE_PLAYER_CACHE_DEBOUNCE_MAX_WAIT = 60000;
    const UPDATE_PLAYER_CACHE_DEBOUNCE_WAIT = 5000;

    function isActivePlayer(player) {
        if (!player.authorized) {
            return false;
        }

        if ((!_.isNil(player.stats.total.captain) && player.stats.total.captain > 0) || (!_.isNil(player.stats.total.player) && player.stats.total.player > 0)) {
            return true;
        }

        return false;
    }

    function formatPlayerListing(player, includeRating) {
        if (includeRating) {
            return {
                id: helpers.getDocumentID(player),
                alias: player.alias,
                steamID: player.steamID,
                groups: _.get(player.toObject(), 'groups'),
                ratingMean: math.round(player.stats.rating.mean),
                ratingDeviation: math.round(player.stats.rating.deviation),
                ratingLowerBound: math.round(player.stats.rating.low),
                ratingUpperBound: math.round(player.stats.rating.high),
                captainScore: player.stats.captainScore && _.isNumber(player.stats.captainScore.center) ? math.round(player.stats.captainScore.center, 3) : null,
                playerScore: player.stats.playerScore && _.isNumber(player.stats.playerScore.center) ? math.round(player.stats.playerScore.center, 3) : null
            };
        }
        else {
            return {
                id: helpers.getDocumentID(player),
                alias: player.alias,
                steamID: player.steamID,
                groups: _.get(player.toObject(), 'groups')
            };
        }
    }

    /**
     * @async
     */
    const updatePlayerList = _.debounce(co.wrap(function* updatePlayerCache() {
        /* eslint-disable lodash/prefer-lodash-method */
        let users = yield database.User.find({}).exec();
        /* eslint-enable lodash/prefer-lodash-method */

        let players = _.orderBy(users, [function(player) {
            return player.stats.rating.mean;
        }, function(player) {
            return player.stats.playerScore ? player.stats.playerScore.center : null;
        }, function(player) {
            return player.stats.captainScore ? player.stats.captainScore.center : null;
        }], ['desc', 'desc', 'desc']);

        yield cache.setAsync('allPlayerList', JSON.stringify(_.map(players, user => formatPlayerListing(user, !HIDE_RATINGS))));
        yield cache.setAsync('activePlayerList', JSON.stringify(_(players).filter(user => isActivePlayer(user)).map(user => formatPlayerListing(user, !HIDE_RATINGS)).value()));
    }), UPDATE_PLAYER_CACHE_DEBOUNCE_WAIT, {
        maxWait: UPDATE_PLAYER_CACHE_DEBOUNCE_MAX_WAIT
    });

    /**
     * @async
     */
    function getPlayerList(inactive) {
        return co(function*() {
            let keyName;

            if (inactive) {
                keyName = 'allPlayerList';
            }
            else {
                keyName = 'activePlayerList';
            }

            let cacheResponse = yield cache.getAsync(keyName);

            if (!cacheResponse) {
                yield updatePlayerList();
                cacheResponse = yield cache.getAsync(keyName);
            }

            return JSON.parse(cacheResponse);
        });
    }

    self.on('cachedUserUpdated', co.wrap(function*(user) {
        yield self.invalidatePlayerPage(user);
        yield updatePlayerList();
    }));

    /**
     * @async
     */
    self.updatePlayerStats = co.wrap(function* updatePlayerStats(player) {
        let playerID = helpers.getDocumentID(player);

        player = yield database.User.findById(playerID);

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let captainGames = yield database.Game.find({
                'teams.captain': helpers.getDocumentID(player),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            player.stats.captainRecord = _.countBy(captainGames, function(game) {
                let teamIndex = _.findIndex(game.teams, function(team) {
                    return helpers.getDocumentID(team.captain) === helpers.getDocumentID(player);
                });

                if (teamIndex === 0) {
                    if (game.score[0] > game.score[1]) {
                        return 'win';
                    }
                    else if (game.score[0] < game.score[1]) {
                        return 'loss';
                    }
                    else if (game.score[0] === game.score[1]) {
                        return 'tie';
                    }
                }
                else if (teamIndex === 1) {
                    if (game.score[1] > game.score[0]) {
                        return 'win';
                    }
                    else if (game.score[1] < game.score[0]) {
                        return 'loss';
                    }
                    else if (game.score[1] === game.score[0]) {
                        return 'tie';
                    }
                }
            });
        }

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let captainGames = yield database.Game.find({
                'teams.captain': helpers.getDocumentID(player),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            let captainScores = _.map(captainGames, function(game) {
                let teamIndex = _.findIndex(game.teams, function(team) {
                    return helpers.getDocumentID(team.captain) === helpers.getDocumentID(player);
                });

                let differential = 0;

                if (teamIndex === 0) {
                    differential = (game.score[0] - game.score[1]) / 5;
                }
                else if (teamIndex === 1) {
                    differential = (game.score[1] - game.score[0]) / 5;
                }

                let duration = game.duration ? game.duration / 1800 : 1;

                return differential / duration;
            });

            player.stats.captainScore = calculatePredictionInterval(captainScores);
        }

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let playerGames = yield database.Game.find({
                'teams.composition.players.user': helpers.getDocumentID(player),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            player.stats.playerRecord = _.countBy(playerGames, function(game) {
                let gameUserInfo = self.getGameUserInfo(game, player);
                let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

                if (teamIndex === 0) {
                    if (game.score[0] > game.score[1]) {
                        return 'win';
                    }
                    else if (game.score[0] < game.score[1]) {
                        return 'loss';
                    }
                    else if (game.score[0] === game.score[1]) {
                        return 'tie';
                    }
                }
                else if (teamIndex === 1) {
                    if (game.score[1] > game.score[0]) {
                        return 'win';
                    }
                    else if (game.score[1] < game.score[0]) {
                        return 'loss';
                    }
                    else if (game.score[1] === game.score[0]) {
                        return 'tie';
                    }
                }
            });
        }

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let playerGames = yield database.Game.find({
                'teams.composition.players.user': helpers.getDocumentID(player),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            let playerScores = _.map(playerGames, function(game) {
                let gameUserInfo = self.getGameUserInfo(game, player);
                let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

                let differential = 0;

                if (teamIndex === 0) {
                    differential = (game.score[0] - game.score[1]) / 5;
                }
                else if (teamIndex === 1) {
                    differential = (game.score[1] - game.score[0]) / 5;
                }

                let duration = game.duration ? game.duration / 1800 : 1;

                return differential / duration;
            });

            player.stats.playerScore = calculatePredictionInterval(playerScores);
        }

        {
            let draftStats = [];

            let captainGameCount = yield database.Game.count({
                'teams.captain': helpers.getDocumentID(player)
            }).count().exec();
            draftStats.push({
                type: 'captain',
                count: captainGameCount
            });

            let draftPositions = {};

            let playersPicked = _(DRAFT_ORDER).filter(['type', 'playerPick']).size();
            for (let i = 1; i <= playersPicked; i++) {
                draftPositions[i] = 0;
            }

            /* eslint-disable lodash/prefer-lodash-method */
            let draftedGames = yield database.Game.find({
                'draft.choices': {
                    $elemMatch: {
                        'type': 'playerPick',
                        'player': helpers.getDocumentID(player)
                    }
                }
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */
            for (let game of draftedGames) {
                let position = 0;

                for (let choice of game.draft.choices) {
                    if (choice.type === 'playerPick') {
                        position++;

                        if (helpers.getDocumentID(choice.player) === helpers.getDocumentID(player)) {
                            break;
                        }
                    }
                }

                if (!draftPositions[position]) {
                    draftPositions[position] = 0;
                }
                draftPositions[position]++;
            }


            _.forEach(draftPositions, function(count, position) {
                draftStats.push({
                    type: 'picked',
                    position,
                    count
                });
            });

            /* eslint-disable lodash/prefer-lodash-method */
            let undraftedCount = yield database.Game.find({
                $nor: [{
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': helpers.getDocumentID(player)
                        }
                    }
                }, {
                    'teams.captain': helpers.getDocumentID(player)
                }],
                'draft.pool.players.user': helpers.getDocumentID(player)
            }).count().exec();
            /* eslint-enable lodash/prefer-lodash-method */
            draftStats.push({
                type: 'undrafted',
                count: undraftedCount
            });

            player.stats.draft = draftStats;
        }

        {
            let rating = yield database.Rating.findOne({
                user: helpers.getDocumentID(player)
            }).sort('-date').exec();

            if (rating) {
                player.stats.rating.mean = rating.after.mean;
                player.stats.rating.deviation = rating.after.deviation;
            }
        }

        {

            player.stats.roles = yield _(ROLES).keys().map(
                /* eslint-disable lodash/prefer-lodash-method */
                role => database.Game.find({
                    'teams.composition': {
                        $elemMatch: {
                            'role': role,
                            'players.user': helpers.getDocumentID(player)
                        }
                    }
                }).count().exec().then(count => ({
                    role,
                    count
                }))
                /* eslint-enable lodash/prefer-lodash-method */
            ).value();
        }

        {
            player.stats.total.captain = yield database.Game.count({
                'teams.captain': helpers.getDocumentID(player)
            }).count().exec();
            player.stats.total.player = yield database.Game.count({
                'teams.composition.players.user': helpers.getDocumentID(player)
            }).count().exec();
        }

        {
            player.stats.replaced.into = yield database.Game.count({
                $nor: [{
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': helpers.getDocumentID(player)
                        }
                    }
                }, {
                    'teams.captain': helpers.getDocumentID(player)
                }],
                'teams.composition.players.user': helpers.getDocumentID(player)
            }).count().exec();
            player.stats.replaced.out = yield database.Game.count({
                'teams.composition.players': {
                    $elemMatch: {
                        'user': helpers.getDocumentID(player),
                        'replaced': true
                    }
                }
            }).count().exec();
        }

        yield player.save();

        yield self.updateCachedUser(player);
    });

    hbs.registerHelper('draftStatToRow', function(stat) {
        if (stat.type === 'captain') {
            return JSON.stringify(['Captain', stat.count]);
        }
        else if (stat.type === 'picked') {
            return JSON.stringify([`Picked ${humanize.ordinal(stat.position)}`, stat.count]);
        }
        else if (stat.type === 'undrafted') {
            return JSON.stringify(['Undrafted', stat.count]);
        }
    });
    hbs.registerHelper('ratingStatToRow', function(stat) {
        return `[new Date("${stat.date}"),${stat.after.mean},${stat.after.low},${stat.after.high}]`;
    });
    hbs.registerHelper('roleStatToRow', function(stat) {
        return JSON.stringify([ROLES[stat.role].name, stat.count]);
    });

    /**
     * @async
     */
    self.invalidatePlayerPage = co.wrap(function* invalidatePlayerPage(player) {
        yield cache.delAsync(`playerPage-${helpers.getDocumentID(player)}`);
    });

    /**
     * @async
     */
    self.getPlayerPage = co.wrap(function* getPlayerPage(player) {
        let cacheResponse = yield cache.getAsync(`playerPage-${helpers.getDocumentID(player)}`);

        let playerPage;

        if (cacheResponse) {
            playerPage = JSON.parse(cacheResponse);
        }
        else {
            let user = yield database.User.findById(helpers.getDocumentID(player));

            if (!user) {
                return null;
            }

            /* eslint-disable lodash/prefer-lodash-method */
            let games = yield database.Game.find({
                $or: [{
                    'teams.captain': helpers.getDocumentID(user)
                }, {
                    'teams.composition.players': {
                        $elemMatch: {
                            user: helpers.getDocumentID(user)
                        }
                    }
                }],
                status: {
                    $in: ['launching', 'live', 'completed']
                }
            }).sort('-date').populate('teams.captain').exec();
            /* eslint-enable lodash/prefer-lodash-method */

            /* eslint-disable lodash/prefer-lodash-method */
            let restrictions = yield database.Restriction.find({
                'user': helpers.getDocumentID(user)
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */

            playerPage = {
                user: user.toObject(),
                games: _.map(games, function(game) {
                    let revisedGame = _.omit(game.toObject(), 'draft', 'server', 'links');

                    if (helpers.getDocumentID(user) === helpers.getDocumentID(game.teams[0].captain)) {
                        revisedGame.reverseTeams = false;
                    }
                    else if (helpers.getDocumentID(user) === helpers.getDocumentID(game.teams[1].captain)) {
                        revisedGame.reverseTeams = true;
                    }
                    else {
                        let gameUserInfo = self.getGameUserInfo(game, user);
                        let team = _.indexOf(game.teams, gameUserInfo.team);

                        revisedGame.reverseTeams = team !== 0;
                    }

                    return revisedGame;
                }),
                restrictions: _(restrictions).invokeMap('toObject').orderBy(['active', 'expires'], ['desc', 'desc']).value(),
                restrictionDurations: RESTRICTION_DURATIONS
            };

            if (!HIDE_RATINGS) {
                /* eslint-disable lodash/prefer-lodash-method */
                let ratings = yield database.Rating.find({
                    'user': helpers.getDocumentID(user)
                }).exec();
                /* eslint-enable lodash/prefer-lodash-method */

                playerPage.ratings = _(ratings).invokeMap('toObject').sortBy('date').value();
            }

            yield cache.setAsync(`playerPage-${helpers.getDocumentID(user)}`, JSON.stringify(playerPage));
        }

        return playerPage;
    });

    app.get('/player/:steam', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            'steamID': req.params.steam
        }).exec();

        let playerPage = yield self.getPlayerPage(user);

        if (playerPage) {
            res.render('player', playerPage);
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    }));

    app.get('/players', co.wrap(function*(req, res) {
        res.render('playerList', {
            players: yield getPlayerList(self.isUserAdmin(req.user))
        });
    }));

    co(function*() {
        yield updatePlayerList();
    });
};
