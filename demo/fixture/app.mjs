export function discountedTotal(items) {
  const total = items.reduce((sum, item) => sum + item.price, 0);
  return total > 100 ? total * 0.9 : total;
}
