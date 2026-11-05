import { registerHooks } from 'node:module';
import { extname } from 'node:path';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // 仅为应用现有的无扩展相对导入补试 .ts，不改包解析或已有路径。
      if ((error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') ||
          (!specifier.startsWith('./') && !specifier.startsWith('../')) || extname(specifier) !== '') throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
