// The parity suite's AWS credentials, apart from the harness so vitest.config.ts can read them:
// the harness imports Vitest's runtime, which a config file cannot load.
export const AWS_ACCESS_KEY_ID = 'AKIAPARITYSUITE';
export const AWS_SECRET_ACCESS_KEY = 'parity-suite-secret';

/**
 * The environment of every test that points AWS clients at moto. moto answers on the wall clock while a test mocks
 * its own, and the SDK retries an error whose Date moves its clock offset.
 */
export const TEST_AWS_ENV = { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DISABLE_CLOCK_SKEW_CORRECTION: 'true' };
