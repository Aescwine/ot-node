const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class assertions extends Model {
        static associate(models) {
            assertions._models = models;
            // define association here
        }
    }
    assertions.init({
        hash: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        owner: DataTypes.STRING,
        signature: DataTypes.TEXT,
        topics: DataTypes.STRING,
        created_at: DataTypes.DATE,
        updated_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'assertions',
    });
    return assertions;
};
