const express = require('express');
const fileUpload = require('express-fileupload');
const ipfilter = require('express-ipfilter').IpFilter;
const fs = require('fs');
const https = require('https');
const { IpDeniedError } = require('express-ipfilter');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const path = require('path');
const { v1: uuidv1, v4: uuidv4 } = require('uuid');
const Models = require('../../models/index');
const constants = require('../constants');

class RpcControllerNew {
    constructor(ctx) {
        this.config = ctx.config;
        this.logger = ctx.logger;
        this.fileService = ctx.fileService;
        this.commandExecutor = ctx.commandExecutor;
        this.assetService = ctx.assetService;

        this.enableSSL();

        this.app = express();
        this.app.use(fileUpload({
            createParentPath: true,
        }));
    }

    enableSSL() {
        this.sslEnabled = fs.existsSync('/root/certs/privkey.pem') && fs.existsSync('/root/certs/fullchain.pem');

        if (this.sslEnabled) {
            this.httpsServer = https.createServer({
                key: fs.readFileSync('/root/certs/privkey.pem'),
                cert: fs.readFileSync('/root/certs/fullchain.pem'),
            }, this.app);
        }
    }

    async initialize() {
        this.initializeAuthenticationMiddleware();

        this.initializeApiRoutes();
        this.initializeErrorMiddleware();

        if (this.sslEnabled) {
            await this.httpsServer.listen(this.config.rpcPort);
        } else {
            await this.app.listen(this.config.rpcPort);
        }
    }

    initializeApiRoutes() {
        // assets
        this.app.post('/assets/create', (req, res, next) => this.assetService.saveAsset(req, res, next, false));
        this.app.get('/assets/create/result/:handler_id', (req, res, next) => this.assetService.getSaveAssetResult(req, res, next));
        this.app.post('/assets/update', (req, res, next) => this.assetService.saveAsset(req, res, next, true));
        this.app.get('/assets/update/result/:handler_id', (req, res, next) => this.assetService.getSaveAssetResult(req, res, next));
        this.app.get('/assets/get', (req, res, next) => this.assetService.getAsset(req, res, next));
        this.app.get('/assets/get/result/:handler_id', (req, res, next) => this.assetService.getAssetResult(req, res, next));
        // this.app.get('/assets/search', this.assetService.search);
        // this.app.get('/assets/search/result/:handler_id', this.assetController.getSearchResult);
    }

    initializeAuthenticationMiddleware() {
        const formattedWhitelist = [];
        const ipv6prefix = '::ffff:';
        for (let i = 0; i < this.config.ipWhitelist.length; i += 1) {
            if (!this.config.ipWhitelist[i].includes(':')) {
                formattedWhitelist.push(ipv6prefix.concat(this.config.ipWhitelist[i]));
            } else {
                formattedWhitelist.push(this.config.ipWhitelist[i]);
            }
        }

        this.app.use((res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });

        this.app.use(ipfilter(formattedWhitelist,
            {
                mode: 'allow',
                log: false,
            }));

        this.app.use((error, req, res, next) => {
            if (error instanceof IpDeniedError) {
                return res.status(401).send('Access denied');
            }
            return next();
        });

        this.app.use((req, res, next) => {
            this.logger.info(`${req.method}: ${req.url} request received`);
            return next();
        });

        this.app.use(
            rateLimit({
                windowMs: constants.SERVICE_API_RATE_LIMIT_TIME_WINDOW_MILLS,
                max: constants.SERVICE_API_RATE_LIMIT_MAX_NUMBER,
                message: `Too many requests sent, maximum number of requests per minute is ${constants.SERVICE_API_RATE_LIMIT_MAX_NUMBER}`,
                standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
                legacyHeaders: false, // Disable the `X-RateLimit-*` headers
            }),
        );

        this.app.use(slowDown({
            windowMs: constants.SERVICE_API_SLOW_DOWN_TIME_WINDOW_MILLS,
            delayAfter: constants.SERVICE_API_SLOW_DOWN_DELAY_AFTER,
            delayMs: constants.SERVICE_API_SLOW_DOWN_DELAY_MILLS,
        }));
    }

    initializeErrorMiddleware() {
        this.app.use((error, req, res, next) => {
            let code;
            let message;
            if (error && error.code) {
                switch (error.code) {
                    case 400:
                        code = 400;
                        message = {
                            status: 'BAD_REQUEST',
                            error: error.error,
                            details: error.message,
                        };
                        break;
                    default:
                        return next(error);
                }
                this.logger.error({ msg: message, Event_name: constants.ERROR_TYPE.API_ERROR_400 });
                return res.status(code).send(message);
            }
            return next(error);
        });

        this.app.use((error, req, res, next) => {
            this.logger.error({ msg: error, Event_name: constants.ERROR_TYPE.API_ERROR_500 });
            return res.status(500).send(error);
        });
    }
}

module.exports = RpcControllerNew;
