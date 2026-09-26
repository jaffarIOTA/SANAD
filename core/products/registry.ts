/**
 * The modules the platform knows, by code.
 *
 * The engine does not import a product; the application that hosts the engine
 * registers the modules it ships and hands the registry in. What the engine
 * does hold is the list of codes that are Islamic products, because a
 * tenant's catalogue cannot enable one of those without a board ruling and
 * the catalogue parser has to know which codes that applies to.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { AnyProductModule } from './module.ts';

export const ISLAMIC_PRODUCT_CODES: ReadonlySet<string> = new Set(['murabaha-scf', 'tawarruq-personal']);

export class ProductRegistry {
  readonly #modules = new Map<string, AnyProductModule>();

  register(module: AnyProductModule): this {
    const code = module.descriptor.code;
    if (this.#modules.has(code)) throw new Error(`product module registered twice: ${code}`);
    if (module.descriptor.family === 'ISLAMIC' !== ISLAMIC_PRODUCT_CODES.has(code)) {
      throw new Error(`product ${code}: family and the Islamic product list disagree`);
    }
    this.#modules.set(code, module);
    return this;
  }

  find(code: string): Result<AnyProductModule> {
    const m = this.#modules.get(code);
    return m === undefined ? reject('OP-DETERMINACY', 'PRODUCT_MODULE_UNKNOWN', 'No product module of that code is registered', { productCode: code }) : ok(m);
  }

  codes(): readonly string[] {
    return [...this.#modules.keys()];
  }
}
