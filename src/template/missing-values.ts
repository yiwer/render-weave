/** 将已有问题关联回当前作用域的缺值；不制造新问题，不把正常的可选缺值变成错误。 */
import type { Problem } from '../problems.js';
import type { Scope } from './scope.js';

export interface DataOrigin {
  readonly path: string;
  /** 基本类型循环项的 value 对应项本身，不另加 .value。 */
  readonly wrapped?: boolean;
}

export function fieldOrigin(origin: DataOrigin | undefined, ref: string): string | undefined {
  if (!origin) return undefined;
  if (origin.wrapped) return ref === 'value' ? origin.path : undefined;
  return origin.path ? `${origin.path}.${ref}` : ref;
}

export class MissingValues {
  constructor(private readonly scope: Scope, private readonly problems: readonly Problem[],
    private readonly origin: DataOrigin | undefined, private readonly parameterProblems: readonly Problem[]) {}

  label(ref: string): string {
    const type = this.scope.table.typeOf(ref);
    return this.scope.table.get(ref)?.displayName || ('type' in type && type.type.displayName) || ref;
  }

  hasProblem(ref: string, seen = new Set<string>()): boolean {
    if (seen.has(ref)) return false;
    seen.add(ref);
    const variable = this.scope.table.get(ref.split('.')[0]!);
    if (!variable || !('type' in this.scope.table.typeOf(ref))) return true;
    const source = this.scope.dataPath(ref);
    if (source !== undefined) {
      const path = fieldOrigin(this.origin, source);
      if (path !== undefined && this.problems.some((problem) => problem.location.kind === 'field' &&
        (problem.location.path === '' || path === problem.location.path || path.startsWith(`${problem.location.path}.`) || path.startsWith(`${problem.location.path}[`)))) return true;
    }
    if (variable.source === 'field') return false;
    if (variable.source === 'parameter') {
      return this.parameterProblems.some((problem) => problem.location.kind === 'parameter' && problem.location.name === variable.name);
    }
    return [...this.problems, ...this.scope.problems].some((problem) => problem.location.kind === 'variable' &&
      problem.location.template === this.scope.template.name && problem.location.name === variable.name) ||
      this.scope.dependencies(variable.name).some((dependency) => this.hasProblem(dependency, seen));
  }
}
