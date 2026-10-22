/** Page contributions roll back in reverse order, including partial installation. */
export function contributionLifetime() {
  const disposers: (() => void)[] = [];
  return {
    own(dispose: () => void) { disposers.push(dispose); return dispose; },
    dispose() {
      const errors: unknown[] = [];
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "片场贡献释放失败");
    }
  };
}
