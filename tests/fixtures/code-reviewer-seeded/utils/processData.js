// SEEDED ISSUE (quadratic loop, W4/Algorithmic Anti-Patterns): O(n²) scan to
// find duplicate IDs. A Set-based approach would be O(n).
export function findDuplicates(items) {
  const duplicates = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {  // quadratic inner loop — line 6
      if (i !== j && items[i].id === items[j].id) {
        duplicates.push(items[i]);
      }
    }
  }
  return duplicates;
}

export function formatUser(user) {
  return { id: user.id, name: user.name.trim() };
}

// SEEDED ISSUE (dead export, W4/Dead Exports): nothing in this fixture
// imports legacyTransform; graphify would show zero callers.
export function legacyTransform(data) {  // dead export — line 19
  return data.map(item => ({ ...item, legacy: true }));
}
