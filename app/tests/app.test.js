const request = require("supertest");
const app = require("../src/server");

describe("e-commerce API", () => {
  test("health endpoint returns ok", async () => {
    const response = await request(app).get("/health");
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  test("returns product list", async () => {
    const response = await request(app).get("/api/products");
    expect(response.statusCode).toBe(200);
    expect(response.body.products.length).toBeGreaterThan(0);
  });

  test("returns 404 for unknown product", async () => {
    const response = await request(app).get("/api/products/not-a-product");
    expect(response.statusCode).toBe(404);
  });

  test("validates checkout payload", async () => {
    const response = await request(app).post("/api/checkout").send({ items: [] });
    expect(response.statusCode).toBe(400);
  });

  test("returns a single product by id", async () => {
    const list = await request(app).get("/api/products");
    const id = list.body.products[0].id;
    const response = await request(app).get(`/api/products/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.body.product.id).toBe(id);
  });

  test("checkout succeeds and totals the cart", async () => {
    const list = await request(app).get("/api/products");
    const { id, price } = list.body.products[0];
    const response = await request(app)
      .post("/api/checkout")
      .send({ items: [{ productId: id, quantity: 2 }] });
    expect(response.statusCode).toBe(200);
    expect(response.body.total).toBe(Number((price * 2).toFixed(2)));
  });

  test("rejects invalid cart items", async () => {
    const response = await request(app)
      .post("/api/checkout")
      .send({ items: [{ productId: "p-100", quantity: 0 }] });
    expect(response.statusCode).toBe(400);
  });

  test("returns 400 for malformed JSON", async () => {
    const response = await request(app)
      .post("/api/checkout")
      .set("Content-Type", "application/json")
      .send("{bad json");
    expect(response.statusCode).toBe(400);
  });
});
