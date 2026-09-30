/** Restores a demo account's password. Development helper only. */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error("usage: node --env-file=.env scripts/reset-demo-password.mjs <email> <password>");
  process.exit(1);
}

const prisma = new PrismaClient();
const result = await prisma.user.updateMany({
  where: { email },
  data: { passwordHash: await bcrypt.hash(password, 12), passwordChangedAt: new Date() },
});
console.log(`updated ${result.count} account(s) for ${email}`);
await prisma.$disconnect();
