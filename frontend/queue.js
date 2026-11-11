export function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const pick = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

export function startQueue(items, selected, shuffle) {
  if (!items.length) return null;
  if (!shuffle) return { items, order: [...items], index: selected ? items.indexOf(selected) : 0 };
  const order = selected ? [selected, ...shuffled(items.filter((id) => id !== selected))] : shuffled(items);
  return { items, order, index: 0 };
}

export function reorderQueue(queue, shuffle) {
  const visited = queue.order.slice(0, queue.index + 1);
  const seen = new Set(visited);
  const upcoming = queue.items.filter((id) => !seen.has(id));
  return { ...queue, order: [...visited, ...(shuffle ? shuffled(upcoming) : upcoming)] };
}

export function nextQueue(queue, repeatAll, shuffle) {
  if (queue.index + 1 < queue.order.length) return { ...queue, index: queue.index + 1 };
  if (!repeatAll) return null;
  const next = startQueue(queue.items, null, shuffle);
  if (shuffle && next.order.length > 1 && next.order[0] === queue.order.at(-1)) {
    [next.order[0], next.order[1]] = [next.order[1], next.order[0]];
  }
  return next;
}
