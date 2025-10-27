#!/bin/bash
# check-mongodb-users.sh - Check Gambino DB content

echo "🔍 Connecting without auth (current backend setup)..."
docker exec -it gambino_mongodb mongosh "mongodb://gambino:SimplePass123%21@localhost:27017/gambino?authSource=gambino" --eval "
  print('✅ Connected without auth');
  print('📋 Collections in gambino:');
  db.getCollectionNames().forEach(c => print('  • ' + c));
  print('\\n👥 Sample users:');
  db.users.find({}, {email:1, role:1}).limit(10).forEach(u => print('  • ' + u.email + ' (role: ' + u.role + ')'));
"
