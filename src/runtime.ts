// runtime 类型在新旧版 SDK 中都以 type-only 方式使用
// 用 any 避免对特定导入路径的依赖

let runtime: any = null;

export function setMyWsRuntime(next: any) {
  runtime = next;
}

export function getMyWsRuntime(): any {
  if (!runtime) {
    throw new Error("wzq-channel runtime 未初始化");
  }
  return runtime;
}
