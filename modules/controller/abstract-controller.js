const validator = require('validator');
const Models = require('../../models/index');

class AbstractController {
    validateHandlerId(handlerId, next) {
        if (!validator.isUUID(handlerId)) {
            return next({
                code: 400,
                message: 'Handler id is in wrong format',
            });
        }
    }

    async getHandlerData(handlerId) {
        const handlerData = await Models.handler_ids.findOne({
            where: {
                handlerId,
            },
        });
        return handlerData;
    }
}

module.exports = AbstractController;
