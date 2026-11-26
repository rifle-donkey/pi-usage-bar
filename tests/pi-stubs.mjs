import { registerHooks } from 'node:module';

const modules = {
  '@earendil-works/pi-coding-agent': `export class CustomEditor {
    renderTopBorder(width) { return '─'.repeat(width); }
  }`,
  '@earendil-works/pi-tui': `export const visibleWidth = text => [...text.replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '')].length;`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (Object.hasOwn(modules, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
