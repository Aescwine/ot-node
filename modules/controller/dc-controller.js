const utilities = require('../Utilities');
const Models = require('../../models');
const Utilities = require('../Utilities');
const constants = require('../constants');
const { QueryTypes } = require('sequelize');
const BN = require('bn.js');
const ObjectValidator = require('../validator/object-validator');

/**
 * DC related API controller
 */
class DCController {
    constructor(ctx) {
        this.logger = ctx.logger;
        this.emitter = ctx.emitter;
        this.apiUtilities = ctx.apiUtilities;
        this.config = ctx.config;
        this.dcService = ctx.dcService;
        this.remoteControl = ctx.remoteControl;
        this.graphStorage = ctx.graphStorage;
        this.transport = ctx.transport;
        this.importService = ctx.importService;
        this.commandExecutor = ctx.commandExecutor;
        this.profileService = ctx.profileService;
        this.blockchain = ctx.blockchain;
        this.permissionedDataService = ctx.permissionedDataService;
    }

    /**
     * Validate create offer request and import
     *
     * @param req   HTTP request
     * @param res   HTTP response
     */
    async handleReplicateRequest(req, res) {
        if (req.body !== undefined && req.body.dataset_id !== undefined && typeof req.body.dataset_id === 'string' &&
            utilities.validateNumberParameter(req.body.holding_time_in_minutes) &&
            utilities.validateStringParameter(req.body.token_amount_per_holder) &&
            utilities.validateStringParameter(req.body.blockchain_id) &&
            utilities.validateNumberParameter(req.body.litigation_interval_in_minutes)) {
            var handlerId = null;
            var offerId = '';
            try {
                const dataset = await Models.data_info.findOne({
                    where: { data_set_id: req.body.dataset_id },
                });
                if (dataset == null) {
                    this.logger.info('Invalid request');
                    res.status(400);
                    res.send({
                        message: 'This data set does not exist in the database',
                    });
                    return;
                }
                let blockchain_id;
                if (req.body.blockchain_id) {
                    // eslint-disable-next-line prefer-destructuring
                    blockchain_id = req.body.blockchain_id;
                    try {
                        this.blockchain._getImplementationFromId(blockchain_id);
                    } catch (error) {
                        this.logger.info(`Invalid request. ${error.toString()}`);
                        res.status(400);
                        res.send({
                            message: `Invalid blockchain_id ${blockchain_id}`,
                        });
                    }
                } else {
                    blockchain_id = this.blockchain.getDefaultBlockchainId();
                }

                const inserted_object = await Models.handler_ids.create({
                    status: 'PENDING',

                });
                handlerId = inserted_object.dataValues.handler_id;
                offerId = await this.dcService.createOffer(
                    req.body.dataset_id, dataset.root_hash, req.body.holding_time_in_minutes,
                    req.body.token_amount_per_holder, dataset.otjson_size_in_bytes,
                    req.body.litigation_interval_in_minutes, handlerId,
                    req.body.urgent, blockchain_id,
                );
                const handler_data = {
                    status: 'PUBLISHING_TO_BLOCKCHAIN',
                    offer_id: offerId,
                };
                await Models.handler_ids.update({
                    data: JSON.stringify(handler_data),
                }, {
                    where: {
                        handler_id: handlerId,
                    },
                });
                res.status(200);
                res.send({
                    handler_id: handlerId,
                });
            } catch (error) {
                this.logger.error(`Failed to create offer. ${error}.`);

                this.errorNotificationService.notifyError(
                    error,
                    {
                        offerId,
                        tokenAmountPerHolder: req.body.token_amount_per_holder,
                        datasetId: req.body.dataset_id,
                        holdingTimeInMinutes: req.body.holding_time_in_minutes,
                    },
                    constants.PROCESS_NAME.offerHandling,
                );

                if (handlerId) {
                    Models.handler_ids.update({
                        status: 'FAILED',
                    }, { where: { handler_id: handlerId } });
                }
                res.status(400);
                res.send({
                    message: `Failed to start offer. ${error}.`,
                });
                this.remoteControl.failedToCreateOffer(`Failed to start offer. ${error}.`);
            }
        } else {
            this.logger.error('Invalid request');
            res.status(400);
            res.send({
                message: 'Invalid parameters!',
            });
        }
    }

    async updatePermissionedDataPrice(req, res) {
        this.logger.api('POST: Set permissioned data price.');
        if (req.body == null
            || req.body.data_set_id == null
            || req.body.ot_object_ids == null) {
            res.status(400);
            res.send({ message: 'Params data_set_id and ot_object_ids are required.' });
            return;
        }

        const blockchain_ids = req.body.blockchain_id ?
            [req.body.blockchain_id] : this.blockchain.getAllBlockchainIds();

        const promises = [];
        req.body.ot_object_ids.forEach((ot_object) => {
            promises.push(new Promise(async (accept, reject) => {
                const condition = {
                    seller_node_id: this.config.identity,
                    data_set_id: req.body.data_set_id.toLowerCase(),
                    ot_json_object_id: ot_object.id,
                    blockchain_id: {
                        [Models.Sequelize.Op.in]: blockchain_ids,
                    },
                };

                const data = await Models.data_sellers.findAll({
                    where: condition,
                });

                if (data && Array.isArray(data) && data.length > 0) {
                    const promises = [];
                    for (const data_object of data) {
                        promises.push(Models.data_sellers.update(
                            { price: ot_object.price_in_trac },
                            { where: { id: data_object.id } },
                        ));
                    }
                    await Promise.all(promises);
                    accept();
                } else {
                    reject(Error(`Could not find a permissioned data object for ${ot_object.id} in dataset ${req.body.data_set_id}`
                   + ` replicated to blockchains: ${blockchain_ids}.`));
                }
            }));
        });
        await Promise.all(promises).then(() => {
            res.status(200);
            res.send({ status: 'COMPLETED' });
        }).catch((error) => {
            res.status(400);
            res.send({ status: error.toString() });
        });
    }

    async handlePermissionedDataReadRequest(message) {
        const {
            data_set_id, dv_erc725_identity, ot_object_id, handler_id, nodeId,
        } = message;

        const privateDataPermissions = await Models.data_trades.findAll({
            where: {
                data_set_id,
                ot_json_object_id: ot_object_id,
                buyer_node_id: nodeId,
                status: 'COMPLETED',
            },
        });
        if (!privateDataPermissions || privateDataPermissions.length === 0) {
            throw Error(`You don't have permission to view objectId:
            ${ot_object_id} from dataset: ${data_set_id}`);
        }

        const { node_wallet, node_private_key } = this.blockchain.getWallet().response;

        const replayMessage = {
            wallet: node_wallet,
            handler_id,
        };
        const promises = [];
        privateDataPermissions.forEach((privateDataPermisssion) => {
            promises.push(this.graphStorage.findDocumentsByImportIdAndOtObjectId(
                data_set_id,
                privateDataPermisssion.ot_json_object_id,
            ));
        });
        const otObjects = await Promise.all(promises);
        replayMessage.ot_objects = otObjects;

        const normalized_dv_erc725_identity = Utilities.normalizeHex(dv_erc725_identity);

        privateDataPermissions.forEach(async (privateDataPermisssion) => {
            await Models.data_sellers.create({
                data_set_id,
                ot_json_object_id: privateDataPermisssion.ot_json_object_id,
                seller_node_id: nodeId.toLowerCase(),
                seller_erc_id: normalized_dv_erc725_identity,
                price: 0,
            });
        });

        const privateDataReadResponseObject = {
            message: replayMessage,
            messageSignature: Utilities.generateRsvSignature(
                JSON.stringify(replayMessage),
                node_private_key,
            ),
        };
        await this.transport.sendPermissionedDataReadResponse(
            privateDataReadResponseObject,
            nodeId,
        );
    }

    async handleNetworkPurchaseRequest(request) {
        const {
            data_set_id, dv_erc725_identity, handler_id,
            dv_node_id, ot_json_object_id, price, blockchain_id,
        } = request;

        // todo validate data in request

        const commandData = {
            data_set_id,
            dv_erc725_identity,
            handler_id,
            ot_json_object_id,
            price,
            blockchain_id,
            dv_node_id,
        };

        await this.commandExecutor.add({
            name: 'dhPurchaseRequestedCommand',
            delay: 0,
            data: commandData,
            transactional: false,
        });
    }

    async getPermissionedDataOwned(req, res) {
        this.logger.api('GET: Permissioned Data Owned.');

        const allMyIdentities = this.blockchain.getAllBlockchainIds()
            .map(id => this.profileService.getIdentity(id));
        const query =
            'SELECT ds.data_set_id, ds.ot_json_object_id, ds.price, ds.blockchain_id, ' +
            '( SELECT Count(*) FROM data_trades dt WHERE dt.seller_erc_id = ds.seller_erc_id ' +
            'AND ds.data_set_id = dt.data_set_id and ds.blockchain_id = dt.blockchain_id AND ' +
            'ds.ot_json_object_id = dt.ot_json_object_id AND dt.status = \'COMPLETED\') as sales ' +
            'FROM  data_sellers ds WHERE ds.seller_erc_id IN (:seller_ercs)';


        const data = await Models.sequelize.query(
            query,
            {
                replacements: { seller_ercs: allMyIdentities },
                type: QueryTypes.SELECT,
            },
        );

        const result = [];

        if (data.length > 0) {
            const owned_objects = {};
            const allDatasets = [];
            /*
               Creating a map of the following structure
               owned_objects: {
                    dataset_0x456: {
                        ot_objects: [ot_object_0x789, ...]
                        ...,
                    },
                    ...
               }
             */
            data.forEach((obj) => {
                if (owned_objects[obj.data_set_id]) {
                    const ot_object = owned_objects[obj.data_set_id]
                        .ot_objects.find(added_obj => added_obj.id === obj.ot_json_object_id);

                    if (ot_object) {
                        ot_object.prices.push({
                            blockchain_id: obj.blockchain_id,
                            price_in_trac: obj.price,
                        });
                        ot_object.sales = (new BN(ot_object.sales, 10))
                            .iadd(new BN(obj.sales, 10)).toString();
                        owned_objects[obj.data_set_id].total_sales.iadd(new BN(obj.sales, 10));
                    } else {
                        owned_objects[obj.data_set_id].ot_objects.push({
                            id: obj.ot_json_object_id,
                            prices: [{
                                blockchain_id: obj.blockchain_id,
                                price_in_trac: obj.price,
                            }],
                            sales: obj.sales,
                        });
                        owned_objects[obj.data_set_id].total_sales.iadd(new BN(obj.sales, 10));
                        owned_objects[obj.data_set_id].total_price.iadd(new BN(obj.price, 10));
                    }
                } else {
                    allDatasets.push(obj.data_set_id);
                    owned_objects[obj.data_set_id] = {};
                    owned_objects[obj.data_set_id].ot_objects = [{
                        id: obj.ot_json_object_id,
                        prices: [{
                            blockchain_id: obj.blockchain_id,
                            price_in_trac: obj.price,
                        }],
                        sales: obj.sales,
                    }];
                    owned_objects[obj.data_set_id].total_sales = new BN(obj.sales, 10);
                    owned_objects[obj.data_set_id].total_price = new BN(obj.price, 10);
                }
            });

            const allMetadata = await this.importService.getMultipleDatasetMetadata(allDatasets);

            const dataInfos = await Models.data_info.findAll({
                where: {
                    data_set_id: {
                        [Models.sequelize.Op.in]: allDatasets,
                    },
                },
            });

            allDatasets.forEach((datasetId) => {
                const { datasetHeader } = allMetadata.find(metadata => metadata._key === datasetId);
                const dataInfo = dataInfos.find(info => info.data_set_id === datasetId);
                owned_objects[datasetId].metadata = {
                    datasetTitle: datasetHeader.datasetTitle,
                    datasetTags: datasetHeader.datasetTags,
                    datasetDescription: datasetHeader.datasetDescription,
                    timestamp: dataInfo.import_timestamp,
                };
            });

            for (const dataset in owned_objects) {
                result.push({
                    timestamp: (new Date(owned_objects[dataset].metadata.timestamp)).getTime(),
                    dataset: {
                        id: dataset,
                        name: owned_objects[dataset].metadata.datasetTitle,
                        description: owned_objects[dataset].metadata.datasetDescription || 'No description given',
                        tags: owned_objects[dataset].metadata.datasetTags,
                    },
                    ot_objects: owned_objects[dataset].ot_objects,
                    total_sales: owned_objects[dataset].total_sales.toString(),
                    total_price: owned_objects[dataset].total_price.toString(),
                });
            }
        }

        res.status(200);
        res.send(result);
    }

    async handleNetworkPriceRequest(request) {
        const {
            data_set_id, handler_id, dv_node_id, ot_json_object_id,
        } = request;

        const { node_wallet, node_private_key } = this.blockchain.getWallet().response;

        let response;
        const data = await Models.data_sellers.findAll({
            where: {
                seller_node_id: this.config.identity,
                data_set_id,
                ot_json_object_id,
            },
        });
        if (data && Array.isArray(data) && data.length > 0) {
            const prices = [];
            for (const price of data) {
                prices.push({
                    blockchain_id: price.blockchain_id,
                    seller_erc_id: this.profileService.getIdentity(price.blockchain_id),
                    price_in_trac: price.price,
                });
            }
            response = {
                handler_id,
                status: 'COMPLETED',
                wallet: node_wallet,
                prices,
            };
        } else {
            response = {
                handler_id,
                status: 'FAILED',
                wallet: node_wallet,
            };
        }


        const dataPriceResponseObject = {
            message: response,
            messageSignature: Utilities.generateRsvSignature(
                response,
                node_private_key,
            ),
        };

        await this.transport.sendPermissionedDataPriceResponse(
            dataPriceResponseObject,
            dv_node_id,
        );
    }


    async removePermissionedData(req, res) {
        if (req.body === undefined ||
            req.body.dataset_id === undefined ||
            req.body.identifier_value === undefined ||
            req.body.identifier_type === undefined
        ) {
            res.status(400);
            res.send({
                message: 'Bad request',
            });
            return;
        }

        const { dataset_id, identifier_value } = req.body;

        let status = await this.permissionedDataService.removePermissionedDataInDb(
            dataset_id,
            identifier_value,
        );

        const allMyIdentities = this.blockchain.getAllBlockchainIds()
            .map(id => this.profileService.getIdentity(id));

        await Models.data_sellers.destroy({
            where: {
                data_set_id: dataset_id,
                seller_erc_id: {
                    [Models.Sequelize.Op.in]: allMyIdentities,
                },
                ot_json_object_id: identifier_value,
            },
        });

        if (status) { status = 'COMPLETED'; } else { status = 'FAILED'; }
        res.status(200);
        res.send({ status });
    }

    /**
     * Query local data
     * @param query Query
     * @returns {Promise<*>}
     */
    async queryLocal(req, res) {
        this.logger.api('POST: Query local request received.');
        if (!req.body) {
            res.status(400);
            res.send({
                message: 'Body is missing',
            });
            return;
        }

        const { query } = req.body;

        this.logger.info(`Local query handling triggered with ${JSON.stringify(query)}.`);
        const validationError = ObjectValidator.validateSearchQueryObject(query);
        if (validationError) {
            throw validationError;
        }

        const { path } = query[0];
        const valuesArray = Utilities.arrayze(query[0].value);

        const result = await this.graphStorage.findLocalQuery({
            idType: path,
            identifierKey: valuesArray,
        });
        const response = this.importService.packLocalQueryData(result);
        for (let i = 0; i < response.length; i += 1) {
            let offer_id = null;

            // eslint-disable-next-line no-await-in-loop
            const offer = await Models.offers.findOne({
                where: { data_set_id: response[i].datasets[0], status: { [Models.Sequelize.Op.not]: 'FAILED' } },
            });

            if (offer) {
                // eslint-disable-next-line prefer-destructuring
                offer_id = offer.offer_id;
            } else {
                // eslint-disable-next-line no-await-in-loop
                const bid = await Models.bids.findOne({
                    where: { data_set_id: response[i].datasets[0], status: { [Models.Sequelize.Op.not]: 'FAILED' } },
                });

                    // eslint-disable-next-line prefer-destructuring
                if (bid) { offer_id = bid.offer_id; }
            }

            // eslint-disable-next-line prefer-destructuring
            response[i].dataset_id = response[i].datasets[0];
            response[i].offer_id = offer_id;
            delete response[i].datasets;
        }

        res.status(200);
        res.send(response);
    }
}

module.exports = DCController;

