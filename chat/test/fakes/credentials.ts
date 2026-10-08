// The parity suite's AWS credentials, apart from the harness so vitest.config.ts can read them:
// the harness imports Vitest's runtime, which a config file cannot load.
export const AWS_ACCESS_KEY_ID = 'AKIAPARITYSUITE';
export const AWS_SECRET_ACCESS_KEY = 'parity-suite-secret';
