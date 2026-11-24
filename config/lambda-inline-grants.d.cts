type InlineGrants = typeof import('./lambda-inline-grants.js', { with: { 'resolution-mode': 'import' } });

export const grantLambdasInline: InlineGrants['grantLambdasInline'];
export const placeLambdasInNetwork: InlineGrants['placeLambdasInNetwork'];
