import assert from "node:assert/strict";
import test from "node:test";

import { discountedTotal } from "./app.mjs";

test("applies the 10 percent discount at the 100 boundary", () => {
  assert.equal(discountedTotal([{ price: 50 }, { price: 50 }]), 90);
});

test("does not discount a total below the boundary", () => {
  assert.equal(discountedTotal([{ price: 40 }, { price: 50 }]), 90);
});
