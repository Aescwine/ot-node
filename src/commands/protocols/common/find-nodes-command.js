import Command from '../../command.js';
import { OPERATION_ID_STATUS } from '../../../constants/constants.js';

class FindNodesCommand extends Command {
    constructor(ctx) {
        super(ctx);
        this.networkModuleManager = ctx.networkModuleManager;
    }

    /**
     * Executes command and produces one or more events
     * @param command
     */
    async execute(command) {
        const { keyword, operationId, minimumAckResponses, errorType, networkProtocols } =
            command.data;

        this.errorType = errorType;
        this.logger.debug(`Searching for closest node(s) for keyword ${keyword}`);

        const closestNodes = [];
        for (const node of await this.findNodes(keyword, operationId)) {
            for (const protocol of networkProtocols) {
                if (node.protocols.includes(protocol)) {
                    closestNodes.push({ id: node.id, protocol });
                    break;
                }
            }
        }

        this.logger.debug(`Found ${closestNodes.length} node(s) for keyword ${keyword}`);

        const batchSize = 2 * minimumAckResponses;
        if (closestNodes.length < batchSize) {
            this.handleError(
                operationId,
                `Unable to find enough nodes for ${operationId}. Minimum number of nodes required: ${batchSize}`,
                this.errorType,
                true,
            );
            return Command.empty();
        }

        return this.continueSequence(
            {
                ...command.data,
                batchSize,
                leftoverNodes: closestNodes,
            },
            command.sequence,
        );
    }

    async findNodes(keyword, operationId) {
        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.FIND_NODES_START,
        );

        const closestNodes = await this.networkModuleManager.findNodes(keyword);

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.FIND_NODES_END,
        );

        return closestNodes;
    }

    /**
     * Builds default findNodesCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'findNodesCommand',
            delay: 0,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }
}

export default FindNodesCommand;