const validator = require('validator');
const constants = require('../constants');
const Models = require('../../models/index');

class AbstractController {
    async getRequestResult(req, res, next, resultProcessorFunction) {
        const { handler_id } = req.params;
        if (!validator.isUUID(handler_id)) {
            return next({
                code: 400,
                message: 'Handler id is in wrong format',
            });
        }

        try {
            const handlerData = await this.getHandlerData(handler_id);

            if (handlerData) {
                if (handlerData.status === 'FAILED') {
                    return res.status(200).send({
                        status: handlerData.status,
                        data: JSON.parse(handlerData.data),
                    });
                }

                const responseResult = await resultProcessorFunction(handlerData, handler_id);
                res.status(200).send(responseResult);
            } else {
                return next({ code: 404, message: `Handler with id: ${handler_id} does not exist.` });
            }
        } catch (e) {
            this.logger.error({
                msg: `Error while trying to fetch asset data for handler id ${handler_id}. Error message: ${e.message}. ${e.stack}`,
                Event_name: constants.ERROR_TYPE.RESULTS_ROUTE_ERROR,
                Event_value1: e.message,
                Id_operation: handler_id,
            });
            return next({ code: 400, message: `Unexpected error at getting asset results: ${e}` });
        }
    }

    async getHandlerData(handler_id) {
        const handlerData = await Models.handler_ids.findOne({
            where: {
                handler_id,
            },
        });
        return handlerData;
    }
}

module.exports = AbstractController;
