/** Seeded numeric rows: variants exercise projection validation, never real resources. */
export function renderRecipeFixture(url: URL): string | undefined {
  if (!url.pathname.startsWith("/recipes")) return undefined;
  const variant = url.searchParams.get("variant") ?? "normal";
  const price = variant === "malformed" ? "120 USD" : variant === "nonfinite" ? "1e999" : "101";
  const field =
    variant === "missing" ? "" : `<span data-testid="price" data-amount="${price}">${price}</span>`;
  const duplicate = variant === "duplicate" ? field : "";
  const privateField =
    variant === "sensitive"
      ? '<span data-secret data-testid="token">fixture-secret-canary</span><div data-sensitive><span data-testid="nested-secret">fixture-nested-canary</span></div>'
      : "";
  const rows =
    variant === "empty"
      ? ""
      : `<article class="product" data-testid="product-row" data-product-id="p1">${field}${duplicate}${privateField}<span data-testid="currency">USD</span></article><article class="product" data-product-id="p2"><span data-testid="price" data-amount="205">205</span><span data-testid="currency">USD</span></article>`;
  return `<!doctype html><html><head><title>Recipe fixture</title></head><body><h1>Products</h1><main>${rows}</main><output id="ledger">0</output><script>window.__recipeFixture={reorder(){const root=document.querySelector('main');root.prepend(root.lastElementChild);root.querySelector('[data-testid="price"]').textContent='307'},reset(){location.reload()}};</script></body></html>`;
}
