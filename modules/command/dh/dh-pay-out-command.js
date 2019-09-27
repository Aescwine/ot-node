const Command = require('../command');
const Utilities = require('../../Utilities');

const Models = require('../../../models/index');
const constants = require('../../constants');

/**
 * Starts token withdrawal operation
 */
class DhPayOutCommand extends Command {
    constructor(ctx) {
        super(ctx);
        this.web3 = ctx.web3;
        this.config = ctx.config;
        this.logger = ctx.logger;
        this.blockchain = ctx.blockchain;
        this.remoteControl = ctx.remoteControl;
    }

    /**
     * Executes command and produces one or more events
     * @param command
     */
    async execute(command) {
        const {
            offerId,
            urgent,
        } = command.data;

        const bid = await Models.bids.findOne({
            where: {
                offer_id: offerId,
                status: { [Models.Sequelize.Op.in]: ['COMPLETED', 'CHOSEN'] },
            },
        });

        if (!bid) {
            this.logger.important(`There is no successful bid for offer ${offerId}. Cannot execute payout.`);
            return Command.empty();
        }

        if (bid.status !== 'COMPLETED') {
            bid.status = 'COMPLETED';
            bid.message = `Offer ${offerId} has been completed`;
            await bid.save({ fields: ['status', 'message'] });
            this.logger.important(`Offer ${offerId} has been completed successfully.`);
        }

        const blockchainIdentity = Utilities.normalizeHex(this.config.erc725Identity);
        await this._printBalances(blockchainIdentity);
        try {
            await this.blockchain.payOut(blockchainIdentity, offerId, urgent);
            this.logger.important(`Payout for offer ${offerId} successfully completed.`);
            await this._printBalances(blockchainIdentity);
        } catch (error) {
            if (error.message.includes('Gas price higher than maximum allowed price')) {
                this.logger.info('Gas price too high, delaying call for 30 minutes');
                return Command.repeat();
            }
            throw error;
        }
        return Command.empty();
    }

    /**
     * Print balances
     * @param blockchainIdentity
     * @return {Promise<void>}
     * @private
     */
    async _printBalances(blockchainIdentity) {
        const balance = await this.blockchain.getProfileBalance(this.config.node_wallet);
        const balanceInTRAC = this.web3.utils.fromWei(balance, 'ether');
        this.logger.info(`Wallet balance: ${balanceInTRAC} TRAC`);

        const profile = await this.blockchain.getProfile(blockchainIdentity);
        const profileBalance = profile.stake;
        const profileBalanceInTRAC = this.web3.utils.fromWei(profileBalance, 'ether');
        this.logger.info(`Profile balance: ${profileBalanceInTRAC} TRAC`);
    }

    /**
     * Builds default command
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'dhPayOutCommand',
            delay: 0,
            period: constants.GAS_PRICE_VALIDITY_TIME_IN_MILLS,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }
}

module.exports = DhPayOutCommand;
