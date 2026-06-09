// SEEDED ISSUE (cyclic dependency, W4/graph-class): repos layer imports from
// services layer, creating a cycle: userService -> userRepository -> userService.
import { validateUserId } from '../services/userService.js'; // cyclic — line 3

export class UserRepository {
  async findById(id) {
    validateUserId(id);
    return db.query('SELECT * FROM users WHERE id = ?', [id]);
  }

  async findPostsByUser(userId) {
    return db.query('SELECT * FROM posts WHERE user_id = ?', [userId]);
  }

  async findAllUsers() {
    return db.query('SELECT * FROM users');
  }
}
