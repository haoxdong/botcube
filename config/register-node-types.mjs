import { registerHooks } from 'node:module';

// Node strips types but keeps relative `.js` specifiers, which name the `.ts` sources in this package.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!/^\.\.?\/.*\.js$/.test(specifier)) throw error;
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
    }
  },
});
