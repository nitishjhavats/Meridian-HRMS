# Subscription, Payments & Coupons

## Pricing
`PlatformSetting.pricePerUserPaise` (default **5900** = ₹59) and
`PlatformSetting.paymentUpiId` (no default: set it in Platform → Settings, or `PAYMENT_UPI_ID`
before the settings row exists; an unset payee makes order creation refuse) are stored in the DB and
edited by Superadmin. **No price literal exists anywhere else in the codebase.**

`amount = userCount × pricePerUser` → `discount = round(amount × coupon.percent / 100)`
capped by `coupon.maxDiscountPaise` if set → `payable = amount − discount`.
All of it is recomputed **server-side** at order creation and again at approval; the
client-submitted amount is ignored.

## Payment order state machine
```
                 ┌───────────────┐
 create order    │   INITIATED   │  order row created, amount frozen, expiresAt = +4h
                 └──────┬────────┘
        user taps "I have paid" + enters confirmation code
                        ▼
                 ┌───────────────┐
                 │ AWAITING_     │  visible in Superadmin queue
                 │ CONFIRMATION  │
                 └──┬────┬────┬──┘
      approve ──────┘    │    └────── reject ──► REJECTED (terminal; user may re-order)
                         │
                    request info ──► INFO_REQUESTED ──(user replies)──► AWAITING_CONFIRMATION
                         │
                         ▼
                    ┌─────────┐
                    │ APPROVED│ ──► subscription activated / seats raised
                    └─────────┘
 no confirmation within 4h from INITIATED ──► EXPIRED (terminal)
 (a confirmed order -- AWAITING_CONFIRMATION / INFO_REQUESTED -- is off the clock: it waits for review)
```
* The 4-hour window is `PlatformSetting.paymentWindowMinutes` (default 240) — Superadmin
  can change it; existing orders keep the window they were created with (`expiresAt`).
* Expiry is enforced **on read and on write** (a lazily-evaluated `isExpired` plus a
  sweep job), so an unconfirmed row can never be approved after its window. Once the
  organisation has confirmed, the clock stops -- a late review still approves.
* Transitions are the only way to mutate an order (`services/billing/orderMachine.ts`);
  every transition writes an `AuditLog` row and a `SubscriptionHistory` row on approval.
* Every write to a payment order is a compare-and-set on the `status` and `updatedAt`
  it was decided on (`writeOrderIfUnchanged`, `src/services/billing/orderWrite.ts`):
  the approval claim, the organisation's submissions, expiry, reject, request-info and
  code issue. A second approval (double-click, two superadmins, the issued code typed
  in two tabs) updates nothing and credits nothing; a stale reject, request-info or
  resubmission cannot reopen an approved order; the loser gets "changed, reload"
  (`approvalRace.test.ts`, `orderWriteRace.test.ts`).
* An organisation's billing endpoints and pages get a `CustomerOrder`
  (`src/services/billing/customerOrder.ts`), built field by field: never the issued
  code's hash or cipher, who issued or reviewed it, or the internal ids
  (`src/services/billing/customerOrder.test.ts`).

## Coupons
```ts
Coupon {
  code (unique, uppercase), percent, maxDiscountPaise?, startsAt, expiresAt,
  maxRedemptions?, redemptionCount, minUserCount?, maxUserCount?,
  appliesToOrgId?  // null = all orgs
  active
}
```
Validation at order time **and** at approval time: active, in window, under
`maxRedemptions`, user count inside range, org eligible. `CouponRedemption` row is
created inside the same transaction that approves the order, with a unique constraint
on `(couponId, orderId)`.

## Payment codes
Six-digit codes the platform owner hands out, listed under **Platform → Payment codes**.
Two kinds, one list, one input box on the organisation's side:

| Kind | Made when | On entry |
|---|---|---|
| **Payment received** (`PaymentOrder.issuedCode*`) | against a request already in the queue, once the owner has seen the money | the order is **approved on the spot**, recorded as the issuer's approval (`settleApproval`, `via: "issued_code"`), and the seats go live |
| **In advance** (`PaymentCode`) | before there is an order — a deal made on the phone; for one organisation or any; with or without a percent discount and a cap; valid N days (default 30) | the order goes to the review queue like a reference would |

An advance code can be entered in two places:
* **At checkout**, in the coupon box (six digits = payment code; letters = coupon). Its
  discount is priced in from the start, so the QR is right; the code is bound to the
  order (`appliedAt`, `paymentOrderId`) in the order's own transaction, and only if
  still free. The confirm screen then offers one button ("I have paid — confirm with my
  code", `mode: "bound-code"`) instead of asking for the digits again.
* **At confirmation**, in the code box. If it carries a discount the order does not have,
  the order is **re-priced** then (`discountPaise`/`payablePaise`, event note records
  old → new) — the customer was told the number on the phone. Approval is still the
  owner's.

Discount is a percent of what is owed **after** any coupon, capped, never below zero.
A code is spent once (`usedAt`), by a conditional `updateMany`; it may be withdrawn
(`revokedAt`) while unused. Hash is SHA-256 so the code can be found by value; the
cipher lets the owner re-read it, and every reveal is audited
(`payment.advance_code_revealed`). The digits never reach the audit log; `codeHash`
and `codeCipher` are in `REDACTED_KEYS`. Guessing is rate-limited per order and per
organisation (`paymentCode` bucket). The machine action is `SUBMIT_ADVANCE_CODE`,
allowed in every confirmation mode.

## Seats & subscription
`Subscription { orgId, seats, status: TRIAL|ACTIVE|PAST_DUE|SUSPENDED|EXPIRED,
currentPeriodStart, currentPeriodEnd }`. Creating an org user is refused when
`activeUsers >= subscription.seats` (checked in a serialisable transaction).
`SubscriptionHistory` keeps every seat/period change with the order that caused it.

## Analytics (§8)
Superadmin analytics reads **historical rows**, never derived current state:
`PaymentOrder` (amount, discount, coupon, seats, approvedAt) joined to `Organization`.
Materialised aggregates: MRR, monthly collection, per-org revenue, paid seats,
average revenue per org, pending/expired value. Filters: month, year, org, status,
coupon, seat range, date range. Exports to CSV.
