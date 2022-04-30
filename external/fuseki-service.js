const axios = require('axios');
const qs = require('qs');
const constants = require('../modules/constants');
const SparqlQueryBuilder = require('./sparql/sparql-query-builder');

class FusekiService {
    constructor(config) {
        this.config = config;
    }

    async initialize(logger) {
        this.sparqlQueryBuilder = new SparqlQueryBuilder();
        this.logger = logger;
        this.config.axios = {
            method: 'post',
            url: `${this.config.url}/${this.config.repositoryName}`,
        };
        this.logger.info('Fuseki module initialized successfully');
    }

    async insert(triples, rootHash) {
        const askQuery = `ASK WHERE { GRAPH <${rootHash}> { ?s ?p ?o } }`;
        const exists = await this.ask(askQuery);
        if (!exists) {
            this.config.axios = {
                method: 'put',
                url: `${this.config.url}/${this.config.repositoryName}/data?graph=${rootHash}`,
                headers: {
                    'Content-Type': 'application/n-quads',
                },
                data: triples,
            };

            await axios(this.config.axios).then(() => true)
                .catch((error) => {
                    this.logger.error({
                        msg: `Failed to write into Fuseki: ${error} - ${error.stack}`,
                        Event_name: constants.ERROR_TYPE.TRIPLE_STORE_INSERT_ERROR,
                    });
                    return false;
                });
        }
        // TODO: else -> Should log if we already have data
    }

    async execute(query) {
        return new Promise((accept, reject) => {
            const data = qs.stringify({
                query,
            });
            this.config.axios = {
                method: 'post',
                url: `${this.config.url}/${this.config.repositoryName}/sparql`,
                headers: {
                    Accept: 'application/sparql-results+json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                data,
            };
            axios(this.config.axios).then((response) => {
                accept(response.data);
            }).catch((e) => reject(e));
        });
    }

    async construct(query) {
        return new Promise((accept, reject) => {
            const data = qs.stringify({
                query,
            });
            this.config.axios = {
                method: 'post',
                url: `${this.config.url}/${this.config.repositoryName}/sparql`,
                headers: {
                    Accept: 'application/n-quads',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                data,
            };
            axios(this.config.axios).then((response) => {
                accept(response.data);
            }).catch((e) => reject(e));
        });
    }

    async ask(query) {
        return new Promise((accept, reject) => {
            const data = qs.stringify({
                query,
            });
            this.config.axios = {
                method: 'post',
                url: `${this.config.url}/${this.config.repositoryName}/sparql`,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                data,
            };
            axios(this.config.axios).then((response) => {
                accept(response.data.boolean);
            }).catch((e) => reject(e));
        });
    }

    async resolve(uri) {
        const query = this.sparqlQueryBuilder.findNQuadsByGraphUri(uri);
        const nquads = await this.construct(query);
        return nquads;
    }

    async assertionsByAsset(uri) {
        const query = this.sparqlQueryBuilder.findAssertionsByUAL(uri);
        const result = await this.execute(query);

        return result.results.bindings;
    }

    async findAssertions(nquads) {
        const sparqlQuery = this.sparqlQueryBuilder.findGraphByNQuads(nquads);
        let graph = await this.execute(sparqlQuery);
        graph = graph.results.bindings.map((x) => x.g.value.replace(`${constants.DID_PREFIX}:`, ''));
        if (graph.length && graph[0] === 'http://www.bigdata.com/rdf#nullGraph') {
            return [];
        }
        return graph;
    }

    async findAssertionsByKeyword(keyword, options, localQuery) {
        const sparqlQuery = this.sparqlQueryBuilder.findAssertionIdsByKeyword(keyword, options, localQuery);
        const result = await this.execute(sparqlQuery);
        return result.results.bindings;
    }

    async findAssetsByKeyword(keyword, options, localQuery) {
        const sparqlQuery = this.sparqlQueryBuilder.findAssetsByKeyword(keyword, options, localQuery);
        const result = await this.execute(sparqlQuery);
        return result.results.bindings;
    }

    async healthCheck() {
        try {
            const response = await axios.get(`${this.config.url}/$/ping`, {});
            if (response.data !== null) {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    getName() {
        return 'Fuseki';
    }
}

module.exports = FusekiService;
