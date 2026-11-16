-- The payee default was a real personal UPI id. A fresh install would have
-- sent its customers' money to that account, and the value was published
-- with the code. The default is now empty: the platform owner sets the payee
-- in Platform -> Settings (or PAYMENT_UPI_ID), and an empty payee makes
-- createOrder refuse instead of guessing. Only the column default changes;
-- the existing settings row keeps whatever payee it already has.
ALTER TABLE "PlatformSetting" ALTER COLUMN "paymentUpiId" SET DEFAULT '';
