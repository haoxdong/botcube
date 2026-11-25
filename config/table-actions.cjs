const VAULT_TABLE_ACTIONS = ['GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'Query', 'ConditionCheckItem'].map(action => `dynamodb:${action}`);

module.exports = { VAULT_TABLE_ACTIONS };
