function isCredentialVariable(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized === "AWACODE_API_KEY"
    || normalized === "OPENAI_API_KEY"
    || normalized.endsWith("_API_KEY")
    || normalized.includes("AUTHORIZATION")
    || normalized.includes("TOKEN")
    || normalized.includes("SECRET");
}

export function filterChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (
      descriptor.enumerable
      && "value" in descriptor
      && typeof descriptor.value === "string"
      && !isCredentialVariable(name)
    ) {
      filtered[name] = descriptor.value;
    }
  }
  return filtered;
}
