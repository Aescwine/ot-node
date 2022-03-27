/* eslint-disable max-len */
const path = require('path');
const { v1: uuidv1, v4: uuidv4 } = require('uuid');
const validator = require('validator');
const Utilities = require('../utilities');
const constants = require('../constants');
const Models = require('../../models/index');
const AbstractController = require('../controller/abstract-controller');

class AssetService extends AbstractController {
    constructor(ctx) {
        super();
        this.logger = ctx.logger;
        this.fileService = ctx.fileService;
        this.publishService = ctx.publishService;
        this.workerPool = ctx.workerPool;
    }

    /**
     * Create or update an asset
     */
    async saveAsset(req, res, next, isUpdate) {
        const operationId = uuidv1();
        this.logger.emit({
            msg: 'Started measuring execution of save asset command',
            Event_name: 'publish_start',
            Operation_name: 'publish',
            Id_operation: operationId,
        });
        this.logger.emit({
            msg: 'Started measuring execution of check arguments for asset save',
            Event_name: 'publish_init_start',
            Operation_name: 'publish_init',
            Id_operation: operationId,
        });

        const validationError = this.validateSaveAssetArguments(req, isUpdate);
        if (validationError) {
            return next(validationError);
        }

        const handlerObject = await Models.handler_ids.create({
            status: 'PENDING',
        });

        const handlerId = handlerObject.dataValues.handler_id;
        res.status(202).send({
            handler_id: handlerId,
        });
        this.logger.emit({
            msg: 'Finished measuring execution of check arguments for asset save',
            Event_name: 'publish_init_end',
            Operation_name: 'publish_init',
            Id_operation: operationId,
        });

        this.logger.emit({
            msg: 'Started measuring execution of preparing arguments for asset save',
            Event_name: 'publish_prep_args_start',
            Operation_name: 'publish_prep_args',
            Id_operation: operationId,
        });

        let fileContent;
        let fileExtension;
        if (req.files) {
            fileContent = req.files.file.data;
            fileExtension = path.extname(req.files.file.name).toLowerCase();
        } else {
            fileContent = req.body.data;
            fileExtension = '.json';
        }
        const visibility = req.body.visibility ? req.body.visibility.toLowerCase() : 'public';
        const { ual } = req.body.ual ? req.body : undefined;

        let promise;
        if (req.body.keywords) {
            promise = this.workerPool.exec('JSONParse', [req.body.keywords.toLowerCase()]);
        } else {
            promise = new Promise((accept) => accept([]));
        }

        promise.then((keywords) => {
            if (keywords.length > 10) {
                keywords = keywords.slice(0, 10);
                this.logger.warn('Too many keywords provided, limit is 10. Including only the first 10 keywords.');
            }
            this.logger.emit({
                msg: 'Finished measuring execution of preparing arguments for asset save',
                Event_name: 'publish_prep_args_end',
                Operation_name: 'publish_prep_args',
                Id_operation: operationId,
            });
            this.publishService.publish(fileContent, fileExtension, keywords, visibility, ual, handlerId, operationId);
        }).then((assertion) => {
            if (assertion) {
                const handlerData = {
                    id: assertion.id,
                    rootHash: assertion.rootHash,
                    signature: assertion.signature,
                    metadata: assertion.metadata,
                };

                Models.handler_ids.update(
                    {
                        data: JSON.stringify(handlerData),
                    },
                    {
                        where: {
                            handler_id: handlerId,
                        },
                    },
                );
            }
        }).catch((e) => {
            this.updateFailedHandlerId(handlerId, e, next);
        });
    }

    validateSaveAssetArguments(req, isUpdate) {
        const errorMessages = [];
        if ((!req.files || !req.files.file || path.extname(req.files.file.name).toLowerCase() !== '.json') && (!req.body.data)) {
            errorMessages.push('No data provided. It is required to have assertion file or data in body, they must be in JSON-LD format.');


            // return { code: 400, message: 'No data provided. It is required to have assertion file or data in body, they must be in JSON-LD format.' };
        }

        if ((req.files && req.files.file && req.files.file.size > constants.MAX_FILE_SIZE)
            || (req.body && req.body.data && Buffer.byteLength(req.body.data, 'utf-8') > constants.MAX_FILE_SIZE)) {
            errorMessages.push(`File size limit is ${constants.MAX_FILE_SIZE / (1024 * 1024)}MB.`);
            // return {
            //     code: 400,
            //     message: `File size limit is ${constants.MAX_FILE_SIZE / (1024 * 1024)}MB.`,
            // };
        }

        // if (req.body && req.body.data && Buffer.byteLength(req.body.data, 'utf-8') > constants.MAX_FILE_SIZE) {
        //     errorMessages.push(`File size limit is ${constants.MAX_FILE_SIZE / (1024 * 1024)}MB.`);
        //     return {
        //         code: 400,
        //         message: `File size limit is ${constants.MAX_FILE_SIZE / (1024 * 1024)}MB.`,
        //     };
        // }

        if (req.body.keywords && !Utilities.isArrayOfStrings(req.body.keywords)) {
            errorMessages.push('Keywords must be a non-empty array of strings, all strings must have double quotes.');

            // return {
            //     code: 400,
            //     message: 'Keywords must be a non-empty array of strings, all strings must have double quotes.',
            // };
        }

        if (req.body.visibility && !['public', 'private'].includes(req.body.visibility)) {
            errorMessages.push('Visibility must be a string, value can be public or private.');
            // return {
            //     code: 400,
            //     message: 'Visibility must be a string, value can be public or private.',
            // };
        }

        if (isUpdate) {
            if (!req.body.ual) {
                errorMessages.push('UAL must be a string.');
                // return {
                //     code: 400,
                //     message: 'UAL must be a string.',
                // };
            }
        }

        if (errorMessages.length > 0) {
            return {
                code: 400,
                error: 'SAVE_ASSET_VALIDATION_ERROR',
                message: errorMessages,
            };
        }
    }

    /**
     * Get the saved asset result
     */
    async getSaveAssetResult(req, res, next) {
        const { handler_id } = req.params;
        this.validateHandlerId(handler_id, next);

        try {
            const handlerData = this.getHandlerData(handler_id);

            if (handlerData) {
                if (handlerData.status === 'FAILED') {
                    return res.status(200).send({ status: handlerData.status, data: JSON.parse(handlerData.data) });
                }

                if (handlerData && handlerData.status === 'COMPLETED') {
                    const documentPath = this.fileService.getHandlerIdDocumentPath(handler_id);
                    const result = await this.fileService.loadJsonFromFile(documentPath);
                    delete result.assertion.data;
                    handlerData.data = result.assertion;
                }
                res.status(200).send({ status: handlerData.status, data: handlerData.data });
            } else {
                next({ code: 404, message: `Handler with id: ${handler_id} does not exist.` });
            }
        } catch (e) {
            this.logger.error({
                msg: `Error while trying to fetch asset data for handler id ${handler_id}. Error message: ${e.message}. ${e.stack}`,
                Event_name: constants.ERROR_TYPE.RESULTS_ROUTE_ERROR,
                Event_value1: e.message,
                Id_operation: handler_id,
            });
            next({ code: 400, message: `Unexpected error at getting asset results: ${e}` });
        }
    }

    /**
     * Get an asset by UAL
     */
    async getAsset(req, res, next) {
        const operationId = uuidv1();
        this.logger.emit({
            msg: 'Started measuring execution of resolve command',
            Event_name: 'resolve_start',
            Operation_name: 'resolve',
            Id_operation: operationId,
        });

        this.logger.emit({
            msg: 'Started measuring execution of resolve init',
            Event_name: 'resolve_init_start',
            Operation_name: 'resolve_init',
            Id_operation: operationId,
        });

        if (!req.query.ids) {
            return next({ code: 400, message: 'Param ids is required.' });
        }

        if (req.query.load === undefined) {
            req.query.load = false;
        }

        this.logger.emit({
            msg: 'Finished measuring execution of resolve init',
            Event_name: 'resolve_init_end',
            Operation_name: 'resolve_init',
            Id_operation: operationId,
        });

        let handlerId = null;
        try {
            const inserted_object = await Models.handler_ids.create({
                status: 'PENDING',
            });
            handlerId = inserted_object.dataValues.handler_id;
            res.status(202).send({
                handler_id: handlerId,
            });

            let ids = [req.query.ids];
            if (req.query.ids instanceof Array) {
                ids = [...new Set(req.query.ids)];
            }
            this.logger.info(`Resolve for ${ids} with handler id ${handlerId} initiated.`);
            const response = [];

            for (let id of ids) {
                let isAsset = false;
                const { assertionId } = await this.blockchainService.getAssetProofs(id);
                if (assertionId) {
                    isAsset = true;
                    id = assertionId;
                }
                this.logger.emit({
                    msg: id,
                    Event_name: 'resolve_assertion_id',
                    Operation_name: 'resolve_assertion_id',
                    Id_operation: operationId,
                });
                this.logger.emit({
                    msg: 'Started measuring execution of resolve local',
                    Event_name: 'resolve_local_start',
                    Operation_name: 'resolve_local',
                    Id_operation: operationId,
                });

                const nquads = await this.dataService.resolve(id, true);

                this.logger.emit({
                    msg: 'Finished measuring execution of resolve local',
                    Event_name: 'resolve_local_end',
                    Operation_name: 'resolve_local',
                    Id_operation: operationId,
                });

                if (nquads) {
                    this.logger.emit({
                        msg: 'Started measuring execution of create assertion from nquads',
                        Event_name: 'resolve_create_assertion_from_nquads_start',
                        Operation_name: 'resolve_create_assertion_from_nquads',
                        Id_operation: operationId,
                    });

                    let assertion = await this.dataService.createAssertion(nquads);

                    this.logger.emit({
                        msg: 'Finished measuring execution of create assertion from nquads',
                        Event_name: 'resolve_create_assertion_from_nquads_end',
                        Operation_name: 'resolve_create_assertion_from_nquads',
                        Id_operation: operationId,
                    });

                    assertion.jsonld.metadata = JSON.parse(sortedStringify(assertion.jsonld.metadata))
                    assertion.jsonld.data = JSON.parse(sortedStringify(await this.dataService.fromNQuads(assertion.jsonld.data, assertion.jsonld.metadata.type)))
                    response.push(isAsset ? {
                        type: 'asset',
                        id: assertion.jsonld.metadata.UALs[0],
                        result: {
                            assertions: await this.dataService.assertionsByAsset(assertion.jsonld.metadata.UALs[0]),
                            metadata: {
                                type: assertion.jsonld.metadata.type,
                                issuer: assertion.jsonld.metadata.issuer,
                                latestState: assertion.jsonld.metadata.timestamp,
                            },
                            data: assertion.jsonld.data
                        }
                    } : {
                        type: 'assertion',
                        id: id,
                        assertion: assertion.jsonld
                    }
                    );
                } else {
                    this.logger.info(`Searching for closest ${this.config.replicationFactor} node(s) for keyword ${id}`);
                    let nodes = await this.networkService.findNodes(id, this.config.replicationFactor);
                    if (nodes.length < this.config.replicationFactor)
                        this.logger.warn(`Found only ${nodes.length} node(s) for keyword ${id}`);
                    nodes = [...new Set(nodes)];
                    for (const node of nodes) {
                        try {
                            const assertion = await this.queryService.resolve(id, req.query.load, isAsset, node, operationId);
                            if (assertion) {
                                assertion.jsonld.metadata = JSON.parse(sortedStringify(assertion.jsonld.metadata))
                                assertion.jsonld.data = JSON.parse(sortedStringify(await this.dataService.fromNQuads(assertion.jsonld.data, assertion.jsonld.metadata.type)))
                                response.push(isAsset ? {
                                    type: 'asset',
                                    id: assertion.jsonld.metadata.UALs[0],
                                    result: {
                                        metadata: {
                                            type: assertion.jsonld.metadata.type,
                                            issuer: assertion.jsonld.metadata.issuer,
                                            latestState: assertion.jsonld.metadata.timestamp,
                                        },
                                        data: assertion.jsonld.data
                                    }
                                } : {
                                    type: 'assertion',
                                    id: id,
                                    assertion: assertion.jsonld
                                }
                                );
                                break;
                            }
                        } catch (e) {
                            this.logger.error({
                                msg: `Error while resolving data from another node: ${e.message}. ${e.stack}`,
                                Event_name: constants.ERROR_TYPE.RESOLVE_ROUTE_ERROR,
                                Event_value1: e.message,
                                Id_operation: operationId,
                            });
                        }
                    }
                }
            }

            const handlerIdCachePath = this.fileService.getHandlerIdCachePath();

            this.logger.emit({
                msg: 'Started measuring execution of resolve save assertion',
                Event_name: 'resolve_save_assertion_start',
                Operation_name: 'resolve_save_assertion',
                Id_operation: operationId,
            });

            await this.fileService
                .writeContentsToFile(handlerIdCachePath, handlerId, JSON.stringify(response));

            this.logger.emit({
                msg: 'Finished measuring execution of resolve save assertion',
                Event_name: 'resolve_save_assertion_end',
                Operation_name: 'resolve_save_assertion',
                Id_operation: operationId,
            });

            await Models.handler_ids.update(
                {
                    status: 'COMPLETED',
                }, {
                where: {
                    handler_id: handlerId,
                },
            },
            );

            this.logger.emit({
                msg: 'Finished measuring execution of resolve command',
                Event_name: 'resolve_end',
                Operation_name: 'resolve',
                Id_operation: operationId,
            });
        } catch (e) {
            this.logger.error({
                msg: `Unexpected error at resolve route: ${e.message}. ${e.stack}`,
                Event_name: constants.ERROR_TYPE.RESOLVE_ROUTE_ERROR,
                Event_value1: e.message,
                Id_operation: operationId,
            });
            this.updateFailedHandlerId(handlerId, e, next);
        }
    }

    async getAssetResult(req, res, next) {
        const { handler_id } = req.params;
        this.validateHandlerId(handler_id, next);

        try {
            const handlerData = this.getHandlerData(handler_id);

            if (handlerData) {
                if (handlerData.status === 'FAILED') {
                    return res.status(200).send({ status: handlerData.status, data: JSON.parse(handlerData.data) });
                }

                if (handlerData && handlerData.status === 'COMPLETED') {
                    const documentPath = this.fileService.getHandlerIdDocumentPath(handler_id);
                    handlerData.data = await this.fileService.loadJsonFromFile(documentPath);
                }
                res.status(200).send({ status: handlerData.status, data: handlerData.data });
            } else {
                next({ code: 404, message: `Handler with id: ${handler_id} does not exist.` });
            }
        } catch (e) {
            this.logger.error({
                msg: `Error while trying to fetch asset data for handler id ${handler_id}. Error message: ${e.message}. ${e.stack}`,
                Event_name: constants.ERROR_TYPE.RESULTS_ROUTE_ERROR,
                Event_value1: e.message,
                Id_operation: handler_id,
            });
            next({ code: 400, message: `Unexpected error at getting asset results: ${e}` });
        }
    }

    /**
     * Search for an asset by keyword
     */
    async search(req, res, next) {

    }

    async getSearchResult(req, res, next) {

    }
}

module.exports = AssetService;
