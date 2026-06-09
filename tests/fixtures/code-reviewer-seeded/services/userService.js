import { UserRepository } from '../repos/userRepository.js';

export function validateUserId(id) {
  if (!id || typeof id !== 'number') throw new Error('Invalid user ID');
}

// SEEDED ISSUE (N+1, W4/graph-class): fetches user + posts per ID in a loop.
// Each iteration fires two DB queries; for 100 users that is 200 round-trips
// instead of 2 bulk queries.
export async function getUsersWithPosts(userIds) {
  const repo = new UserRepository();
  const results = [];
  for (const id of userIds) {
    const user = await repo.findById(id);           // N+1 query — line 14
    const posts = await repo.findPostsByUser(id);   // N+1 query — line 15
    results.push({ user, posts });
  }
  return results;
}

export function processUsers(users) {
  return users.map(u => ({ id: u.id, name: u.name }));
}
