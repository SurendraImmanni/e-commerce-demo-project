const express = require("express");
const path = require("path");
const products = require("./products");

const app = express();
const port = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/api/products", (_req, res) => res.json({ products }));
app.get("/api/products/:id", (req, res) => {
  const product = products.find((item) => item.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  return res.json({ product });
});

// Demo-only checkout endpoint: it does not take payment or persist orders.
app.post("/api/checkout", (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Provide at least one cart item" });
  }
  const valid = items.every((item) =>
    item && typeof item.productId === "string" &&
    Number.isInteger(item.quantity) && item.quantity > 0
  );
  if (!valid) return res.status(400).json({ error: "Invalid cart items" });

  const total = items.reduce((sum, item) => {
    const product = products.find((p) => p.id === item.productId);
    return sum + (product ? product.price * item.quantity : 0);
  }, 0);
  return res.status(200).json({
    message: "Demo checkout successful. No payment was processed.",
    orderReference: `DEMO-${Date.now()}`,
    total: Number(total.toFixed(2))
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error("Unhandled application error:", err.message);
  res.status(status).json({ error: status === 500 ? "Internal server error" : "Bad request" });
});

if (require.main === module) {
  app.listen(port, "0.0.0.0", () => console.log(`E-commerce app listening on ${port}`));
}

module.exports = app;
