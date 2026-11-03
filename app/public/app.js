const cart = new Map();
let products = [];

const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

async function loadProducts() {
  const response = await fetch("/api/products");
  if (!response.ok) throw new Error("Could not load products");
  ({ products } = await response.json());
  const root = document.querySelector("#products");
  root.innerHTML = products.map((p) => `
    <article class="product-card">
      <img src="${p.image}" alt="">
      <h3>${p.name}</h3>
      <p>${p.description}</p>
      <p class="price">${money(p.price)}</p>
      <button class="button" data-add="${p.id}">Add to cart</button>
    </article>`).join("");
}

function renderCart() {
  const entries = [...cart.entries()];
  const count = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
  document.querySelector("#cart-count").textContent = count;
  document.querySelector("#checkout").disabled = count === 0;
  const root = document.querySelector("#cart-items");
  if (!entries.length) {
    root.textContent = "Your cart is empty.";
    return;
  }
  root.innerHTML = entries.map(([id, quantity]) => {
    const p = products.find((item) => item.id === id);
    return `<div class="cart-row"><span>${p.name} × ${quantity} — ${money(p.price * quantity)}</span>
      <span><button class="small-button" data-minus="${id}" aria-label="Remove one ${p.name}">−</button>
      <button class="small-button" data-plus="${id}" aria-label="Add one ${p.name}">+</button></span></div>`;
  }).join("");
}

document.addEventListener("click", async (event) => {
  const add = event.target.closest("[data-add]");
  const plus = event.target.closest("[data-plus]");
  const minus = event.target.closest("[data-minus]");
  if (add) cart.set(add.dataset.add, (cart.get(add.dataset.add) || 0) + 1);
  if (plus) cart.set(plus.dataset.plus, (cart.get(plus.dataset.plus) || 0) + 1);
  if (minus) {
    const next = (cart.get(minus.dataset.minus) || 0) - 1;
    if (next <= 0) cart.delete(minus.dataset.minus);
    else cart.set(minus.dataset.minus, next);
  }
  if (add || plus || minus) renderCart();
});

document.querySelector("#checkout").addEventListener("click", async () => {
  const items = [...cart.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items })
  });
  const result = await response.json();
  document.querySelector("#checkout-message").textContent =
    response.ok ? `${result.message} Reference: ${result.orderReference}. Total: ${money(result.total)}` : result.error;
  if (response.ok) {
    cart.clear();
    renderCart();
  }
});

loadProducts().then(renderCart).catch((error) => {
  document.querySelector("#products").textContent = error.message;
});
