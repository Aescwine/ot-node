import TripleStoreModuleManager from '../../src/modules/triple-store/triple-store-module-manager.js';

class Utilities {
    static unpackRawTableToArray(rawTable) {
        return rawTable.rawTable[0];
    }

    /**
     * Unpacks cucumber dictionary into simple dictionary
     * @param rawTable
     */
    static unpackRawTable(rawTable) {
        const parse = (val) => {
            if (!Number.isNaN(Number(val))) {
                return Number(val);
            }

            if (val.toLowerCase() === 'true' || val.toLowerCase() === 'false') {
                return Boolean(val);
            }

            return val;
        };

        const unpacked = {};
        if (rawTable) {
            for (const row of rawTable.rawTable) {
                let value;
                if (row.length > 2) {
                    value = [];
                    for (let index = 1; index < row.length; index += 1) {
                        if (!row[index] != null && row[index] !== '') {
                            value.push(parse(row[index]));
                        }
                    }
                } else {
                    value = parse(row[1]);
                }

                const keyParts = row[0].split('.');
                if (keyParts.length === 1) {
                    unpacked[keyParts[0]] = value;
                } else {
                    let current = unpacked;
                    for (let j = 0; j < keyParts.length - 1; j += 1) {
                        if (!current[keyParts[j]]) {
                            current[keyParts[j]] = {};
                        }
                        current = current[keyParts[j]];
                    }
                    current[keyParts[keyParts.length - 1]] = value;
                }
            }
        }
        return unpacked;
    }

    static async deleteTripleStoreRepositories(config, logger) {
        const tripleStoreModuleManager = new TripleStoreModuleManager({ config, logger });
        await tripleStoreModuleManager.initialize();

        for (const implementationName of tripleStoreModuleManager.getImplementationNames()) {
            // eslint-disable-next-line no-shadow
            const { module, config } =
                tripleStoreModuleManager.getImplementation(implementationName);
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(
                Object.keys(config.repositories).map((repository) =>
                    module.deleteRepository(repository),
                ),
            );
        }
    }
}

export default Utilities;
