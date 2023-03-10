require('dotenv/config');
const express = require('express');
const staticMiddleware = require('./static-middleware');
const errorMiddleware = require('./error-middleware');
const jsonMiddleware = express.json();
const ClientError = require('./client-error');
const authMiddleware = require('./auth-middleware');
const jwt = require('jsonwebtoken');
const pg = require('pg');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_TEST);

app.use(jsonMiddleware);
app.use(staticMiddleware);

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get('/api/shoes', (req, res, next) => {
  const sql = `
  select "productId",
          "sku",
          "name",
          "price",
          "imageUrl",
          "brand"
    from "shoes"
  `;
  db.query(sql)
    .then(result => {
      const shoes = result.rows;
      res.status(200).json(shoes);
    })
    .catch(err => next(err));
});

app.get('/api/shoes/:productId', (req, res, next) => {
  const sql = `
    select "productId",
          "sku",
          "name",
          "price",
          "imageUrl",
          "brand",
          array_agg("size") as sizes
    from "shoes"
    join "sizes" using ("productId")
    where "productId" = $1
    group by "productId"
  `;

  const params = [Number(req.params.productId)];

  db.query(sql, params)
    .then(result => {
      const product = result.rows[0];
      if (!product) {
        throw new ClientError(404, 'Product is not found');
      }
      res.status(200).json(product);
    })
    .catch(err => next(err));
});

app.post('/api/addToCart', (req, res, next) => {
  const token = req.get('X-Access-Token');
  if (!token) {
    const cartSql = `
      insert into "cart" ("purchased")
              values ('false')
      returning "cartId"
    `;
    db.query(cartSql)
      .then(result => {
        const cartId = result.rows[0];
        const payload = cartId;
        const token = jwt.sign(payload, process.env.TOKEN_SECRET);
        const cartItem = req.body;
        const { productId, quantity, size } = cartItem;
        const sql = `
          insert into "cartItems" ("cartId", "productId", "quantity", "size")
          values ($1, $2, $3, $4)
          returning *
        `;
        const params = [payload.cartId, productId, quantity, size];
        db.query(sql, params)
          .then(result => {
            res.json({ token, cartItem: result.rows[0] });
          })
          .catch(err => next(err));
      })
      .catch(err => next(err));
  } else {
    const payload = jwt.verify(token, process.env.TOKEN_SECRET);
    const cartId = payload.cartId;
    const cartItem = req.body;
    const { productId, quantity, size } = cartItem;
    const sql = `
      insert into "cartItems" ("cartId", "productId", "quantity", "size")
      values ($1, $2, $3, $4)
      returning *
    `;
    const params = [cartId, productId, quantity, size];
    db.query(sql, params)
      .then(result => {
        res.json({ token, cartItem: result.rows[0] });
      })
      .catch(err => next(err));
  }
});

app.get('/api/cart', (req, res, next) => {
  const token = req.get('X-Access-Token');
  if (!token) {
    return res.json([]);
  }
  const payload = jwt.verify(token, process.env.TOKEN_SECRET);
  const cartId = payload.cartId;
  const sql = `
  select "itemId",
         "cartId",
         "productId",
         "name",
         "price",
         "size",
         "quantity",
         "imageUrl"
    from "cart"
    join "cartItems" using("cartId")
    join "shoes" using("productId")
    where "cartId" = $1
    order by "itemId" DESC
`;
  const params = [cartId];
  db.query(sql, params)
    .then(result => {
      const cartItems = result.rows;
      res.status(200).json(cartItems);
    })
    .catch(err => next(err));
});

app.use(authMiddleware);

app.delete('/api/cartItems/:itemId', (req, res, next) => {
  const { cartId } = req.cartId;
  const itemId = Number(req.params.itemId);
  const sql = `
      delete from "cartItems"
        where "itemId" = $1
  `;
  const params = [itemId];
  db.query(sql, params)
    .then(result => {
      const sql = `
          select "itemId",
              "cartId",
              "productId",
              "name",
              "price",
              "size",
              "quantity",
              "imageUrl"
          from "cart"
          join "cartItems" using("cartId")
          join "shoes" using("productId")
          where "cartId" = $1
          order by "itemId" DESC
      `;
      const params = [cartId];
      db.query(sql, params)
        .then(result => {
          const cartItems = result.rows;
          res.status(200).json(cartItems);
        })
        .catch(err => next(err));
    })
    .catch(err => next(err));
});

app.post('/api/checkout', (req, res, next) => {
  const token = req.get('X-Access-Token');
  const payload = jwt.verify(token, process.env.TOKEN_SECRET);
  const cartId = payload.cartId;
  const checkoutInfo = req.body;
  const { email, firstName, lastName, address, address2, city, state, zipCode, country, total } = checkoutInfo;
  if (!token) {
    throw new ClientError(404, 'Cart was not found.');
  }
  const sql = `
      insert into "usersAddress" ("email", "firstName", "lastName", "address", "address2", "city", "state", "zipCode", "country" )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning *
  `;
  const params = [email, firstName, lastName, address, address2, city, state, zipCode, country];
  db.query(sql, params)
    .then(result => {
      const customer = result.rows[0];
      const { userId } = customer;
      const sql = `
        insert into "orders" ("cartId", "userId", "totalCost")
        values($1, $2, $3)
        returning *
      `;
      const params = [cartId, userId, total];
      db.query(sql, params)
        .then(result => {
          const sql = `
          update "cart"
          set "purchased" = true
          where "cartId" = $1
          returning *
          `;
          const params = [cartId];
          db.query(sql, params)
            .then(result => res.json(result.rows[0]))
            .catch(err => next(err));
        })
        .catch(err => next(err));
    })
    .catch(err => next(err));
});

app.get('/api/cost', (req, res, next) => {
  const { cartId } = req.cartId;
  const sql = `
    select sum("price")
        from "shoes"
        join "cartItems" using ("productId")
        join "cart" using ("cartId")
        where "cartId" = $1
  `;
  const params = [cartId];
  db.query(sql, params)
    .then(result => {
      const costs = {};
      costs.subtotal = Number(result.rows[0].sum);
      costs.taxes = (costs.subtotal * 0.0775).toFixed(2);
      costs.total = Number((costs.subtotal + Number((costs.taxes))).toFixed(2));
      costs.subtotal = Number(costs.subtotal.toFixed(2)).toLocaleString('en', {
        minimumFractionDigits: 2
      });
      costs.total = Number(costs.total.toFixed(2)).toLocaleString('en', {
        minimumFractionDigits: 2
      });
      res.json(costs);
    })
    .catch(err => next(err));
});

app.post('/create-payment-intent', async (req, res, next) => {
  const { cartId } = req.cartId;
  const sql = `
    select sum("price")
        from "shoes"
        join "cartItems" using ("productId")
        join "cart" using ("cartId")
        where "cartId" = $1
    `;
  const params = [cartId];
  db.query(sql, params)
    .then(result => Number(result.rows[0].sum))
    .then(result => {
      const subtotal = result;
      const taxes = subtotal * 0.0775;
      const total = subtotal + taxes;
      return (Math.trunc(total) * 100);
    })
    .then(result => {
      stripe.paymentIntents.create({
        amount: result,
        currency: 'usd',
        automatic_payment_methods: {
          enabled: true
        }
      })
        .then(paymentIntent => {
          res.send({
            clientSecret: paymentIntent.client_secret
          });
        })
        .catch(err => next(err));
    })
    .catch(err => next(err));

});

app.use(errorMiddleware);

app.listen(process.env.PORT, () => {
  process.stdout.write(`\n\napp listening on port ${process.env.PORT}\n\n`);
});
