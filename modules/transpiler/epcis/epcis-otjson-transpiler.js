const xml2js = require('xml-js');
const uuidv4 = require('uuid/v4');
const xsd = require('libxml-xsd');
const utilities = require('../../Utilities');
const importUtilities = require('../../ImportUtilities');
const OtJsonUtilities = require('../../OtJsonUtilities');
const constants = require('../../constants');

const fs = require('fs');

const deepExtend = require('deep-extend');

class EpcisOtJsonTranspiler {
    constructor(ctx) {
        this.config = ctx.config;
        /* todo This is a workaround to detect if a node is running in a spawned process or in the
        main loop, we should find another way to make this distinction */
        this.logger = ctx.logger;

        this.connectionTypes = ['SOURCE', 'DESTINATION', 'EPC', 'EPC_QUANTITY', 'QUANTITY_LIST_ITEM', 'HAS_DATA', 'CONNECTOR_FOR', 'CONNECTION_DOWNSTREAM', 'PARENT_EPC', 'CHILD_EPC', 'READ_POINT', 'BIZ_LOCATION'];
    }

    /**
     * Convert EPCIS XML document to OT-JSON
     * @param xml - XML string
     * @param blockchain
     * @return {*} - OT-JSON object
     */
    convertToOTJson(xml, blockchain) {
        if (xml == null) {
            throw new Error('[Transpilation Error] XML document cannot be empty');
        }

        const xsdFileBuffer = fs.readFileSync('./modules/transpiler/epcis/xsd_schemas/EPCglobal-epcis-masterdata-1_2.xsd');
        const schema = xsd.parse(xsdFileBuffer.toString());

        const validationResult = schema.validate(xml);
        if (validationResult !== null) {
            throw Error(`[Transpilation Error] Failed to validate schema. ${validationResult}`);
        }

        const jsonRaw = xml2js.xml2js(xml, {
            compact: true,
            spaces: 4,
        });
        const json = this._removeCommentsAndTrimTexts(jsonRaw);
        this.arrayze(json, ['attribute', 'VocabularyElement', 'Vocabulary', 'epc', 'AggregationEvent', 'ObjectEvent', 'TransactionEvent', 'TransformationEvent', 'quantityElement', 'childQuantityList', 'source', 'destination', 'childEPCs', 'bizTransaction']);

        const otjson = {
            '@graph': [],
        };

        const otEvents = this._convertEventsFromJson(json);
        const otVocabularyObjects = this._convertVocabulariesFromJson(json);

        otjson['@graph'].push(...otVocabularyObjects);
        otjson['@graph'].push(...otEvents);

        const otGeneratedVocabularyObjects = this._createNonExistingVocabularyData(otjson['@graph']);
        otjson['@graph'].push(...otGeneratedVocabularyObjects);

        const otConnectors = [];
        for (const otEvent of otEvents) {
            const newConnectors = this._createConnectors(otEvent);
            otConnectors.push(...newConnectors);
        }
        otjson['@graph'].push(...otConnectors);

        if (otEvents.length > 0) {
            delete json['epcis:EPCISDocument'].EPCISBody.EventList;
        }

        if (otVocabularyObjects.length > 0) {
            delete json['epcis:EPCISDocument'].EPCISHeader.extension.EPCISMasterData.VocabularyList.Vocabulary;
        }

        const transpilationInfo = this._getTranspilationInfo();
        transpilationInfo.diff = json;

        otjson['@id'] = '';
        otjson['@type'] = 'Dataset';
        otjson.datasetHeader = importUtilities.createDatasetHeader(
            this.config,
            transpilationInfo,
            blockchain,
        );
        importUtilities.calculateGraphPermissionedDataHashes(otjson['@graph']);

        let result = OtJsonUtilities.prepareDatasetForNewImport(otjson);
        if (!result) {
            result = otjson;
        }
        result['@id'] = importUtilities.calculateGraphPublicHash(result);
        const merkleRoot = importUtilities.calculateDatasetRootHash(result);
        importUtilities.attachDatasetRootHash(result.datasetHeader, merkleRoot);

        // Until we update all routes to work with commands, keep this signing implementation
        /* todo This is a workaround to detect if a node is running in a spawned process or in the
        main loop, we should find another way to make this distinction */
        if (this.logger) {
            result = importUtilities.signDataset(result, blockchain);
        } else {
            const sortedDataset = OtJsonUtilities.prepareDatasetForOldImport(result);
            if (sortedDataset) {
                result = sortedDataset;
            }
        }
        return result;
    }

    /**
     * Creates non existing vocabulary data
     * @private
     */
    _createNonExistingVocabularyData(graph) {
        const results = [];
        const filtered = graph.filter(e => e.relations != null && e.relations.length > 0);
        for (const element of filtered) {
            const { relations } = element;
            for (const relation of relations) {
                const id = relation.linkedObject['@id'];
                let existing = graph.find(e => e['@id'] === id);
                if (existing == null) {
                    existing = results.find(e => e['@id'] === id);
                }
                if (existing != null) {
                    // eslint-disable-next-line
                    continue;
                }
                const vocabularyElement = {
                    '@type': 'otObject',
                    '@id': id,
                    properties: {
                        objectType: 'vocabularyElement',
                        ___autogenerated: true,
                    },
                    identifiers: [],
                    relations: [],
                };
                vocabularyElement.identifiers = Object.entries(this._parseGS1Identifier(id)).map(([key, value]) => ({ '@type': key, '@value': value }));
                results.push(vocabularyElement);
            }
        }
        return results;
    }

    /**
     * Remove comments from raw json
     */
    _removeCommentsAndTrimTexts(obj) {
        if (typeof obj === 'object' || Array.isArray((obj))) {
            if (this._isLeaf(obj)) {
                obj._text = obj._text.trim();
            }
            if (obj._comment) {
                delete obj._comment;
            }
            for (const key of Object.keys(obj)) {
                obj[key] = this._removeCommentsAndTrimTexts(obj[key]);
            }
        }
        Object.keys(obj).forEach(k => (obj[k] === undefined ? delete obj[k] : '')); // remove undefined
        return obj;
    }

    /**
     * Convert OT-JSON to EPCIS XML document
     * @param otjson - OT-JSON object
     * @return {string} - XML string
     */
    convertFromOTJson(otjson) {
        if (otjson == null) {
            throw new Error('OT-JSON document cannot be empty');
        }

        if (!otjson.datasetHeader.transpilationInfo
            || otjson.datasetHeader.transpilationInfo.transpilationInfo.transpilerType !== 'GS1-EPCIS') {
            throw new Error('Unable to convert to requested standard. Original dataset was not imported in GS1-EPCIS format.');
        }
        const json = utilities.copyObject(otjson.datasetHeader.transpilationInfo.diff);

        const graph = utilities.copyObject(otjson['@graph']);
        const otVocabularyObjects = graph.filter(x => x.properties != null && x.properties.objectType === 'vocabularyElement' && x.properties.___autogenerated == null);
        if (otVocabularyObjects.length > 0) {
            json['epcis:EPCISDocument'].EPCISHeader.extension.EPCISMasterData.VocabularyList = this._convertVocabulariesToJson(otVocabularyObjects);
        }

        const otEventObjects = graph.filter(x => x.properties != null && ['ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent'].includes(x.properties.objectType));

        const otEventsByType = {};
        for (const otEventObject of otEventObjects) {
            if (otEventsByType[otEventObject.properties.objectType] == null) {
                otEventsByType[otEventObject.properties.objectType] = [];
            }
            otEventsByType[otEventObject.properties.objectType]
                .push(this._convertOTEventToJson(otEventObject));
        }

        if (otEventObjects.length > 0) {
            json['epcis:EPCISDocument'].EPCISBody = {
                EventList: otEventsByType,
            };
        }

        if (json['epcis:EPCISDocument'].EPCISBody.EventList.TransformationEvent) {
            json['epcis:EPCISDocument'].EPCISBody.EventList.extension = {
                TransformationEvent: json['epcis:EPCISDocument'].EPCISBody.EventList.TransformationEvent,
            };
            delete json['epcis:EPCISDocument'].EPCISBody.EventList.TransformationEvent;
        }
        return xml2js.js2xml(json, {
            compact: true,
            spaces: 4,
        });
    }

    /**
     * Converts vocabulary master data from JSON format to OT-JSON
     */
    _convertVocabulariesFromJson(object) {
        let root = object['epcis:EPCISDocument'];
        if (root == null) {
            throw new Error('Invalid EPCIS document!');
        }

        root = root.EPCISHeader;
        if (root == null) {
            return [];
        }

        root = root.extension;
        if (root == null) {
            return [];
        }

        root = root.EPCISMasterData;
        if (root == null) {
            return [];
        }

        root = root.VocabularyList;
        if (root == null) {
            return [];
        }

        root = root.Vocabulary;
        if (root == null) {
            return [];
        }

        const result = [];
        for (const vocabulary of root) {
            const { type } = vocabulary._attributes;
            const vocabularyElements = vocabulary.VocabularyElementList.VocabularyElement;
            for (const vocabularyElement of vocabularyElements) {
                const properties = {
                    objectType: 'vocabularyElement',
                    vocabularyType: type,
                    ___metadata: this._extractMetadata(vocabularyElement),
                };

                for (const attribute of vocabularyElement.attribute) {
                    if (this._isLeaf(attribute)) {
                        properties[attribute._attributes.id] = attribute._text.trim();
                    } else {
                        properties[attribute._attributes.id] = this._compressText(attribute);
                    }
                }

                // remove permissioned data from vocabularyElements
                if (properties.___metadata.attribute &&
                    Array.isArray(properties.___metadata.attribute)) {
                    for (let i = properties.___metadata.attribute.length - 1; i >= 0; i -= 1) {
                        const attribute = properties.___metadata.attribute[i];
                        if (attribute._attributes.visibility &&
                            attribute._attributes.visibility.startsWith('permissioned')) {
                            if (!properties.permissioned_data) {
                                properties.permissioned_data = { data: { attribute: [] } };
                            }
                            properties.permissioned_data.data.attribute
                                .push(utilities.copyObject(attribute));
                            if (attribute._attributes.visibility
                                === constants.PERMISSIONED_DATA_VISIBILITY_HIDE_ATTRIBUTE) {
                                // in this case we want to hide whole attribute
                                properties.___metadata.attribute.splice(i, 1);
                                delete properties[attribute._attributes.id];
                            } else if (attribute._attributes.visibility
                                === constants.PERMISSIONED_DATA_VISIBILITY_SHOW_ATTRIBUTE) {
                                // in this case we want to hide attribute value
                                attribute._text = '';
                                properties[attribute._attributes.id] = '';
                            }
                        }
                    }
                }

                const otVocabulary = {
                    '@id': vocabularyElement._attributes.id,
                    '@type': 'otObject',
                    identifiers: [],
                    relations: [],
                    properties,
                };
                // TODO Find out what happens when there is no _attribute.id
                if (vocabularyElement._attributes.id) {
                    otVocabulary.identifiers =
                        Object.entries(this._parseGS1Identifier(vocabularyElement._attributes.id))
                            .map(([key, value]) => ({ '@type': key, '@value': value }));
                }

                otVocabulary.identifiers.push(...this._findIdentifiers(vocabularyElement));

                if (vocabularyElement.children) {
                    const compressedChildren = this._compressText(vocabularyElement.children);
                    otVocabulary.properties.children = utilities.arrayze(compressedChildren.id);
                    otVocabulary.properties.children.forEach(id => otVocabulary.relations.push({
                        '@type': 'otRelation',
                        direction: 'direct', // TODO think about direction
                        relationType: 'HAS_CHILD',
                        linkedObject: {
                            '@id': id,
                        },
                        properties: {
                        },
                    }));
                }

                if (vocabularyElement.extension) {
                    const compressedExtension = this._compressText(vocabularyElement.extension);
                    otVocabulary.properties.extension = compressedExtension;
                }
                result.push(otVocabulary);
            }
        }
        return result;
    }

    /**
     * Converts vocabulary master data from OT-JSON format to JSON
     */
    _convertVocabulariesToJson(otVocabularyElementList) {
        const elementsByType = {};
        for (const otVocabularyElement of otVocabularyElementList) {
            const { properties } = otVocabularyElement;

            if (properties.___autogenerated === true) {
                // eslint-disable-next-line
                continue;
            }

            if (properties.permissioned_data &&
                properties.permissioned_data.data &&
                properties.permissioned_data.data.attribute &&
                Array.isArray(properties.permissioned_data.data.attribute)) {
                properties.permissioned_data.data.attribute.forEach((attribute) => {
                    if (attribute._attributes.visibility && attribute._attributes.visibility
                        === constants.PERMISSIONED_DATA_VISIBILITY_SHOW_ATTRIBUTE) {
                        const element = properties.___metadata.attribute
                            .find(element => element._attributes.id === attribute._attributes.id);
                        element._text = attribute._text;
                        properties[attribute._attributes.id] = attribute._text;
                    } else if (attribute._attributes.visibility && attribute._attributes.visibility
                        === constants.PERMISSIONED_DATA_VISIBILITY_HIDE_ATTRIBUTE) {
                        properties.___metadata.attribute.push(attribute);
                        properties[attribute._attributes.id] = attribute._text;
                    }
                });
            }

            delete properties.objectType;
            const type = properties.vocabularyType;
            delete properties.vocabularyType;
            const metadata = properties.___metadata;
            delete properties.___metadata;

            for (const [key, value] of Object.entries(properties)) {
                const m = metadata.attribute.find(x => x._attributes.id === key);
                deepExtend(m, this._decompressText(value));
            }

            const vocabularyElement = metadata;
            if (elementsByType[type] == null) {
                elementsByType[type] = [];
            }

            const { children: otChildren } = otVocabularyElement.properties;
            if (otChildren) {
                vocabularyElement.children = {
                    id: this._decompressText(otChildren),
                };
            }

            const { extension: otExtension } = otVocabularyElement.properties;
            if (otExtension) {
                const decompressedExtension = this._decompressText(otExtension);
                vocabularyElement.extension =
                    this._completeExtend(vocabularyElement.extension, decompressedExtension);
            }

            elementsByType[type].push(vocabularyElement);
        }

        const vocabulary = {
            Vocabulary: [],
        };

        for (const type of Object.keys(elementsByType)) {
            const vocabularyItem = {
                _attributes: {
                    type,
                },
            };
            vocabularyItem.VocabularyElementList = {
                VocabularyElement: elementsByType[type],
            };
            vocabulary.Vocabulary.push(vocabularyItem);
        }
        return vocabulary;
    }

    /**
     * Converts events to OT-JSON objects
     * @param object - original JSON parsed XML data
     * @return {Array} - Array of Event OT-JSON objects
     * @private
     */
    _convertEventsFromJson(object) {
        const results = [];

        let root = object['epcis:EPCISDocument'];
        if (root == null) {
            throw new Error('Invalid EPCIS document!');
        }

        root = root.EPCISBody;
        if (root == null) {
            return [];
        }

        root = root.EventList;
        if (root == null) {
            return [];
        }

        if (root.ObjectEvent) {
            for (const event of root.ObjectEvent) {
                results.push(this._convertEventFromJson(event, 'ObjectEvent'));
            }
        }
        if (root.AggregationEvent) {
            for (const event of root.AggregationEvent) {
                results.push(this._convertEventFromJson(event, 'AggregationEvent'));
            }
        }

        if (root.TransactionEvent) {
            for (const event of root.TransactionEvent) {
                results.push(this._convertEventFromJson(event, 'TransactionEvent'));
            }
        }

        if (root.extension) {
            if (Array.isArray(root.extension)) {
                for (const eventList of root.extension) {
                    for (const event of eventList.TransformationEvent) {
                        results.push(this._convertEventFromJson(event, 'TransformationEvent'));
                    }
                }
            } else {
                for (const event of root.extension.TransformationEvent) {
                    results.push(this._convertEventFromJson(event, 'TransformationEvent'));
                }
            }
        }
        return results;
    }

    /**
     * Converts single Event to OT-JSON event object
     * @param event - Event from original JSON data
     * @param eventType - Event type (ObjectEvent, etc)
     * @return {{"@type": string, "@id": string, identifiers: *[]}}
     * @private
     */
    _convertEventFromJson(event, eventType) {
        const id = `urn:uuid:${uuidv4()}`;

        const otObject = {
            '@type': 'otObject',
            '@id': id,
            identifiers: [
                {
                    '@type': 'uuid',
                    '@value': id,
                },
            ],
            relations: [],
            properties: {
                objectType: eventType,
            },
        };

        const foundIdentifiers = this._findIdentifiers(event);
        if (foundIdentifiers.length > 0) {
            otObject.identifiers.push(...foundIdentifiers);
        }

        otObject.properties.___metadata = this._extractMetadata(event);
        const compressed = this._compressText(event);

        const createRelation = (id, relType, data) => ({
            '@type': 'otRelation',
            direction: 'direct', // think about direction
            relationType: relType,
            linkedObject: {
                '@id': id,
            },
            properties: data || {},
        });
        if (compressed.epcList && compressed.epcList.epc) {
            for (const epc of compressed.epcList.epc) {
                otObject.relations.push(createRelation(epc, 'EPC', {}));
            }
        }

        if (compressed.sourceList) {
            const sources = compressed.sourceList.source;
            for (let i = 0; i < sources.length; i += 1) {
                const data = {
                    relationType: 'SOURCE',
                };
                const type = this._extractType(otObject.properties.___metadata, 'sourceList.source', i);
                if (type) {
                    Object.assign(data, {
                        type,
                    });
                }
                otObject.relations.push(createRelation(sources[i], data));
            }
        }

        if (compressed.destinationList) {
            const destinations = compressed.destinationList.destination;
            for (let i = 0; i < destinations.length; i += 1) {
                const data = {
                    relationType: 'DESTINATION',
                };
                const type = this._extractType(otObject.properties.___metadata, 'destinationList.destination', i);
                if (type) {
                    Object.assign(data, {
                        type,
                    });
                }
                otObject.relations.push(createRelation(destinations[i], data));
            }
        }

        if (compressed.inputEPCList && compressed.inputEPCList.epc) {
            for (const epc of compressed.inputEPCList.epc) {
                otObject.relations.push(createRelation(epc, 'INPUT_EPC'));
            }
        }

        if (compressed.inputQuantityList && compressed.inputQuantityList.quantityElement) {
            for (const inputEPC of compressed.inputQuantityList.quantityElement) {
                const data = {
                    relationType: 'INPUT_EPC_QUANTITY',
                    quantity: inputEPC.quantity,
                };
                if (inputEPC.uom) {
                    Object.assign(data, {
                        uom: inputEPC.uom,
                    });
                }
                otObject.relations.push(createRelation(inputEPC.epcClass, data));
            }
        }

        if (compressed.outputEPCList && compressed.outputEPCList.epc) {
            for (const epc of compressed.outputEPCList.epc) {
                otObject.relations.push(createRelation(epc, 'OUTPUT_EPC'));
            }
        }

        if (compressed.outputQuantityList && compressed.outputQuantityList.quantityElement) {
            for (const outputEPC of compressed.outputQuantityList.quantityElement) {
                const data = {
                    relationType: 'OUTPUT_EPC_QUANTITY',
                    quantity: outputEPC.quantity,
                };
                if (outputEPC.uom) {
                    Object.assign(data, {
                        uom: outputEPC.uom,
                    });
                }
                otObject.relations.push(createRelation(outputEPC.epcClass, data));
            }
        }

        if (compressed.extension) {
            if (compressed.extension.quantityList) {
                for (const epc of compressed.extension.quantityList.quantityElement) {
                    otObject.relations.push(createRelation(epc.epcClass, 'EPC_QUANTITY', {
                        quantity: epc.quantity,
                        uom: epc.uom,
                    }));
                }
            }

            if (compressed.extension.childQuantityList) {
                for (const childEPCs of compressed.extension.childQuantityList) {
                    for (const childEPC of childEPCs.quantityElement) {
                        const data = {
                            quantity: childEPC.quantity,
                        };
                        if (childEPC.uom) {
                            Object.assign(data, {
                                uom: childEPC.uom,
                            });
                        }
                        otObject.relations.push(createRelation(childEPC.epcClass, 'CHILD_EPC_QUANTITY', data));
                    }
                }
            }

            if (compressed.extension.sourceList) {
                const sources = compressed.extension.sourceList.source;
                for (let i = 0; i < sources.length; i += 1) {
                    const data = {};
                    const type = this._extractType(otObject.properties.___metadata, 'extension.sourceList.source', i);
                    if (type) {
                        Object.assign(data, {
                            type,
                        });
                    }
                    otObject.relations.push(createRelation(sources[i], 'SOURCE', data));
                }
            }

            if (compressed.extension.destinationList) {
                const destinations = compressed.extension.destinationList.destination;
                for (let i = 0; i < destinations.length; i += 1) {
                    const data = {};
                    const type = this._extractType(otObject.properties.___metadata, 'extension.destinationList.destination', i);
                    if (type) {
                        Object.assign(data, {
                            type,
                        });
                    }
                    otObject.relations.push(createRelation(destinations[i], 'DESTINATION', data));
                }
            }
        }

        if (compressed.bizLocation) {
            otObject.relations.push(createRelation(
                compressed.bizLocation.id,
                'BIZ_LOCATION',
                {},
            ));
        }

        if (compressed.readPoint) {
            otObject.relations.push(createRelation(compressed.readPoint.id, 'READ_POINT', {}));
        }

        if (compressed.parentID) {
            otObject.relations.push(createRelation(compressed.parentID, 'PARENT_EPC', {}));
        }

        if (compressed.childEPCs) {
            for (const childEPCs of compressed.childEPCs) {
                for (const childEPC of childEPCs.epc) {
                    otObject.relations.push(createRelation(childEPC, 'CHILD_EPC', {}));
                }
            }
        }

        Object.assign(otObject.properties, compressed);
        return otObject;
    }

    /**
     * Extract type from metadata
     */
    _extractType(metadata, path, index) {
        if (path == null) {
            return null;
        }
        const chunks = path.split('.');

        let current = metadata;
        for (const chunk of chunks) {
            current = current[chunk];
            if (current == null) {
                return null;
            }
        }
        if (current == null) {
            return null;
        }
        const attributes = current[index]._attributes;
        if (attributes) {
            return attributes.type;
        }
        return null;
    }

    /**
     * Converts OT-JSON event object to original JSON object
     * @param event - OT-JSON object
     * @return {*}
     * @private
     */
    _convertOTEventToJson(event) {
        if (event == null) {
            return null;
        }

        const { properties } = event;
        delete properties.objectType;
        const metadata = properties.___metadata;
        delete properties.___metadata;

        const decompressed = this._decompressText(properties);
        this._appendMetadata(decompressed, metadata);
        return decompressed;
    }

    /**
     * Create OT-JSON connectors
     * @param otEvent - OT-JSON event object
     * @return {Array}
     * @private
     */
    _createConnectors(otEvent) {
        const connectors = [];
        const eventId = otEvent['@id'];
        if (otEvent.properties.bizTransactionList) {
            for (const bizTransaction of otEvent.properties.bizTransactionList.bizTransaction) {
                const [connectionId, erc725Identity] = bizTransaction.split(':');
                connectors.push({
                    '@id': `urn:uuid:${uuidv4()}`,
                    '@type': 'otConnector',
                    identifiers: [{
                        '@type': 'id',
                        '@value': connectionId,
                    }],
                    properties: {
                        expectedConnectionCreators: [
                            {
                                '@type': 'ERC725',
                                '@value': erc725Identity,
                                validationSchema: '../ethereum-erc',
                            },
                        ],
                    },
                    relations: [
                        {
                            '@type': 'otRelation',
                            direction: 'direct',
                            relationType: 'CONNECTOR_FOR',
                            linkedObject: {
                                '@id': eventId,
                            },
                            properties: null,
                        },
                    ],
                });
            }
        }
        return connectors;
    }

    /**
     * Utility function that compresses the original JSON object (from XML)
     * @param object - JSON object
     * @return {*}
     * @private
     */
    _compressText(object) {
        if (this._isLeaf(object)) {
            return object._text.trim();
        }
        if (Array.isArray(object)) {
            const clone = [];
            for (const item of object) {
                clone.push(this._compressText(item));
            }
            return clone;
        } else if (typeof object === 'object') {
            const clone = {};
            for (const key of Object.keys(object)) {
                if (!this._isReserved(key)) {
                    clone[key] = this._compressText(object[key]);
                }
            }
            return clone;
        }
    }

    /**
     * Utility function that decompresses compressed document to original JSON (from XML)
     * @param object - decompressed JSON object
     * @return {*}
     * @private
     */
    _decompressText(object) {
        if (Array.isArray(object)) {
            const clone = [];
            for (const item of object) {
                clone.push(this._decompressText(item));
            }
            return clone;
        } else if (typeof object === 'object') {
            const clone = {};
            for (const key of Object.keys(object)) {
                clone[key] = this._decompressText(object[key]);
            }
            return clone;
        }
        return {
            _text: object,
        };
    }

    /**
     * Utility function that extends an object which can contain an array of objects
     * @param target - object to which the extension will happen
     * @param source - object from which values will be taken
     * @return {*}
     * @private
     */
    _completeExtend(target, source) {
        if (Array.isArray(target)) {
            const clone = [];
            if (target.length > source.length) {
                for (let i = 0; i < source.length; i += 1) {
                    clone.push(this._completeExtend(target[i], source[i]));
                }
            } else {
                for (let i = 0; i < target.length; i += 1) {
                    clone.push(this._completeExtend(target[i], source[i]));
                }
                for (let i = target.length; i < source.length; i += 1) {
                    clone.push(source[i]);
                }
            }
            return clone;
        } else if (typeof target === 'object') {
            const clone = {};
            for (const key of Object.keys(target)) {
                if (source[key]) {
                    clone[key] = this._completeExtend(target[key], source[key]);
                } else {
                    clone[key] = (target[key]);
                }
            }
            for (const key of Object.keys(source)) {
                if (!target[key]) {
                    clone[key] = (source[key]);
                }
            }
            return clone;
        }
        return source;
    }

    /**
     * Adds metadata recursively
     */
    _appendMetadata(object, metadata) {
        if (this._isLeaf(object)) {
            if (metadata != null) {
                Object.assign(object, metadata);
            }
        } else if (Array.isArray(object)) {
            if (metadata != null) {
                for (let i = 0; i < object.length; i += 1) {
                    this._appendMetadata(object[i], metadata[i]);
                }
            }
        } else if (typeof object === 'object') {
            if (metadata != null) {
                for (const key of Object.keys(object)) {
                    if (metadata[key] != null) {
                        if (metadata[key]._attributes != null) {
                            object[key]._attributes = metadata[key]._attributes;
                        }
                    }
                    this._appendMetadata(object[key], metadata[key]);
                }
            }
        }
    }

    /**
     * Extracts metadata from JSON (_comment, _attributes)
     */
    _extractMetadata(object) {
        if (this._isLeaf(object)) {
            return object;
        }
        if (Array.isArray(object)) {
            const clone = [];
            let arrayHasMetadata = false;
            for (const item of object) {
                const keyMetadata = this._extractMetadata(item);
                clone.push((keyMetadata));
                if (keyMetadata != null) {
                    arrayHasMetadata = true;
                }
            }
            if (clone.length === 0 || !arrayHasMetadata) {
                return null;
            }
            return clone;
        } else if (typeof object === 'object') {
            const clone = {};
            for (const key of Object.keys(object)) {
                if (key !== '_attributes') {
                    const keyMetadata = this._extractMetadata(object[key]);
                    if (keyMetadata != null) {
                        clone[key] = keyMetadata;
                    }
                }
            }
            if (object._attributes) {
                clone._attributes = object._attributes;
            }

            if (Object.keys(clone).length === 0) {
                return null;
            }
            return clone;
        }
    }

    /**
     * Extracts OT-JSON identifiers from object
     * @param object - JSON Object
     * @param parentKey - Parent key (needed because of recursion)
     * @return {Array}
     * @private
     */
    _findIdentifiers(object, parentKey) {
        const identifiers = [];

        if (Array.isArray(object)) {
            for (const item of object) {
                identifiers.push(...this._findIdentifiers(item, parentKey));
            }
        } else if (typeof object === 'object') {
            if (this._isLeaf(object)) {
                if (object._attributes != null && object._attributes.identifier) {
                    if (parentKey === 'attribute') {
                        identifiers.push({
                            '@type': this._trimIdentifier(object._attributes.id),
                            '@value': object._text,
                        });
                    } else {
                        identifiers.push({
                            '@type': this._trimIdentifier(parentKey),
                            '@value': object._text,
                        });
                    }
                }
            } else {
                for (const key of Object.keys(object)) {
                    identifiers.push(...this._findIdentifiers(object[key], key));
                }
            }
        }
        return identifiers;
    }

    /**
     * Is leaf node in the original JSON document
     * @param object - Original JSON document
     * @return {boolean}
     * @private
     */
    _isLeaf(object) {
        return object._text != null;
    }

    /**
     * Is reserved key in original JSON object
     * @param key - key
     * @return {boolean}
     * @private
     */
    _isReserved(key) {
        return key === '_comment' || key === '_attributes';
    }

    /**
     * Is alphanumeric?
     * @param character
     * @return {boolean}
     * @private
     */
    _alphaNum(character) {
        if (/[^a-zA-Z0-9]/.test(character)) {
            return false;
        }
        return true;
    }

    /**
     * Trims GS1 identifier
     * @param untrimmed
     * @return {string}
     * @private
     */
    _trimIdentifier(untrimmed) {
        const n = untrimmed.length;

        let i = n - 1;

        while (i > 0) {
            if (!this._alphaNum(untrimmed.charAt(i))) {
                i += 1;
                break;
            }

            i -= 1;
        }

        return untrimmed.substring(i);
    }

    /**
     * Parse GS1 identifier into smaller chunks (company, lot, etc)
     * @private
     */
    _parseGS1Identifier(identifier) {
        const regex = /^urn:epc:\w+:(\w+):([\d]+).([\d]+).?([\w*]+)?$/g;
        const splitted = regex.exec(identifier);

        if (!splitted) {
            return {
                id: identifier, // TEMP FIX, REMOVE LAYER,
            };
        }

        const identifierType = splitted[1];
        const companyPrefix = splitted[2];

        let identifiers = {};
        let checkDigit = 0;
        let itemReference = '';

        switch (identifierType) {
        // eslint-disable-next-line
            case 'sgtin':
            // eslint-disable-next-line
                itemReference = splitted[3];
            const serial = splitted[4];
            checkDigit = this._checkDigitGS1(`${companyPrefix.substr(1)}${itemReference}`);

            identifiers = {
                sgtin: identifier,
                companyPrefix: companyPrefix.substr(1),
                itemReference,
                gtin: `${companyPrefix.substr(1)}${itemReference}${checkDigit}`,
            };

            if (serial) {
                identifiers.serial = serial;
            }
            break;
            // eslint-disable-next-line
            case 'giai':
            // eslint-disable-next-line
                itemReference = splitted[3];
            const serialGiai = splitted[4];
            checkDigit = this._checkDigitGS1(`${companyPrefix.substr(1)}${itemReference}`);

            identifiers = {
                giai: identifier,
                companyPrefix: companyPrefix.substr(1),
                itemReference,
            };

            if (serialGiai) {
                identifiers.serial = serialGiai;
            }
            break;
            // eslint-disable-next-line
            case 'sscc':
            // eslint-disable-next-line
                const serialReference = splitted[3];
            checkDigit = this._checkDigitGS1(`${companyPrefix.substr(1)}${serialReference}`);

            identifiers = {
                sscc: identifier,
                companyPrefix: companyPrefix.substr(1),
                serialReference,
                gs1_128: `${companyPrefix.substr(1)}${serialReference}${checkDigit}`,
            };
            break;
            // eslint-disable-next-line
            case 'lgtin':
            // eslint-disable-next-line
                itemReference = splitted[3];
            const lotNumber = splitted[4];
            checkDigit = this._checkDigitGS1(`${companyPrefix.substr(1)}${itemReference}`);

            identifiers = {
                lgtin: identifier,
                companyPrefix: companyPrefix.substr(1),
                itemReference,
                gtin: `${companyPrefix.substr(1)}${itemReference}${checkDigit}`,
            };

            if (lotNumber) {
                identifiers.lotNumber = lotNumber;
            }
            break;
        case 'pgln':
            // eslint-disable-next-line
            case 'sgln':
            const locationReference = splitted[3];
            const extension = splitted[4];
            checkDigit = this._checkDigitGS1(`${companyPrefix.substr(1)}${locationReference}`);

            identifiers = {
                sgln: identifier,
                companyPrefix: companyPrefix.substr(1),
                locationReference,
                gln: `${companyPrefix.substr(1)}${locationReference}${checkDigit}`,
            };

            if (extension) {
                identifiers.extension = extension;
            }
            break;
        default:
            throw Error('Invalid identifier type');
        }
        return identifiers;
    }

    /**
     * Gets GS1 digit
     * @param n
     * @return {number}
     * @private
     */
    _checkDigitGS1(n) {
        const l = n.length;
        let v = 0;
        let p = false;

        for (let i = l - 1; i >= 0; i -= 1) {
            // eslint-disable-next-line
            if ((p = !p)) {
                v += (parseInt(n[i], 10) * 3);
            } else {
                v += parseInt(n[i], 10);
            }
        }
        return ((Math.ceil(v / 10) * 10) - v);
    }

    /**
     * If there's only one element, wrap it into array
     */
    arrayze(json, attributes) {
        if (json == null) {
            return null;
        }

        if (Array.isArray(json)) {
            for (const item of json) {
                this.arrayze(item, attributes);
            }
        } else if (typeof json === 'object') {
            for (const key of Object.keys(json)) {
                if (attributes.includes(key)) {
                    if (!Array.isArray(json[key])) {
                        json[key] = [json[key]];
                    }
                }
                this.arrayze(json[key], attributes);
            }
        }
    }

    /**
     * Gets transpilation information.
     * Diff should be populated with unparsed data from original EPCIS document
     * @return *
     */
    _getTranspilationInfo() {
        const created = new Date();
        return {
            transpilationInfo: {
                transpilerType: 'GS1-EPCIS',
                transpilerVersion: '1.1',
                sourceMetadata: {
                    created: created.toISOString(),
                    modified: created.toISOString(),
                    standard: 'GS1-EPCIS',
                    XMLversion: '1.0',
                    encoding: 'UTF-8',
                },
                diff: {},
            },
        };
    }

    getConnectionTypes() {
        return this.connectionTypes;
    }
}

module.exports = EpcisOtJsonTranspiler;
