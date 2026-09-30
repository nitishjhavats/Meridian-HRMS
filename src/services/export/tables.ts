/**
 * What goes in, and how each table finds its way back to the organisation.
 *
 * Left out deliberately: `FileObject` (the bytes themselves — an export is a
 * record of the data, not a second copy of every upload), `LoginEvent` and
 * `PasswordResetRequest` (security telemetry, not company records),
 * `DataExportJob` (it would contain the passphrase for other exports),
 * `AiConfig` (an API key), `Notification` (transient), `AttendancePin` (spent
 * one-shot codes — the hashes are meaningless and the fact that a bypass
 * happened is already on the exported `AttendanceEvent`), and everything
 * platform-level.
 *
 * And **chat**. `ChatThread`, `ChatMessage`, `ChatBlock` and `ChatReport` are
 * deliberately absent: this file is downloaded by an organisation's owner under
 * a permission described to them as "your data", and it must not be the thing
 * that hands them every private conversation in the company. A conversation is
 * readable one pair at a time through `chat.export`, with a written reason on
 * the organisation's own audit log and both participants told.
 */
export interface ExportTable {
  /** The Prisma delegate name, i.e. the model name with a lowercase first letter. */
  model: string;
  /** How rows of this table reach back to an organisation. */
  where: (organizationId: string) => object;
}

export const TABLES: ExportTable[] = [
  // --- structure
  { model: "department", where: (organizationId) => ({ organizationId }) },
  { model: "designation", where: (organizationId) => ({ organizationId }) },
  { model: "designationReporting", where: (organizationId) => ({ organizationId }) },
  { model: "workLocation", where: (organizationId) => ({ organizationId }) },
  { model: "shift", where: (organizationId) => ({ organizationId }) },
  { model: "weeklyOffPattern", where: (organizationId) => ({ organizationId }) },
  { model: "holiday", where: (organizationId) => ({ organizationId }) },
  { model: "orgPolicyVersion", where: (organizationId) => ({ organizationId }) },
  { model: "orgModuleSetting", where: (organizationId) => ({ organizationId }) },
  // The two layers that narrow a module for a designation or one person. An
  // organisation's own configuration, and an answer to "why can she not see
  // this screen" that would otherwise live only in the database.
  { model: "designationModuleSetting", where: (organizationId) => ({ organizationId }) },
  { model: "userModuleSetting", where: (organizationId) => ({ organizationId }) },
  // How many days of each leave type a designation gets.
  { model: "designationLeaveAllocation", where: (organizationId) => ({ organizationId }) },

  // --- people
  { model: "user", where: (organizationId) => ({ organizationId }) },
  { model: "employee", where: (organizationId) => ({ organizationId }) },
  { model: "employmentStateChange", where: (organizationId) => ({ employee: { organizationId } }) },
  { model: "reportingRelationship", where: (organizationId) => ({ organizationId }) },

  // --- attendance
  { model: "attendanceDay", where: (organizationId) => ({ organizationId }) },
  { model: "attendanceEvent", where: (organizationId) => ({ organizationId }) },
  { model: "attendanceRegularisation", where: (organizationId) => ({ organizationId }) },
  { model: "kioskDevice", where: (organizationId) => ({ organizationId }) },
  // Configuration, not a secret: who an administrator has said may hand out an
  // attendance PIN. `AttendancePin` itself stays out -- those are spent hashes.
  { model: "attendancePinAuthority", where: (organizationId) => ({ organizationId }) },

  // --- leave
  { model: "leaveType", where: (organizationId) => ({ organizationId }) },
  { model: "leaveBalance", where: (organizationId) => ({ organizationId }) },
  // What was carried between years, and the prior figures it can be undone to.
  // In the export because it is the only record of why a balance changed at a
  // year end -- the balances themselves only ever show the answer.
  { model: "leaveCarryForwardRun", where: (organizationId) => ({ organizationId }) },
  { model: "leaveRequest", where: (organizationId) => ({ organizationId }) },
  { model: "leaveApproval", where: (organizationId) => ({ request: { organizationId } }) },

  // --- pay
  { model: "salaryComponent", where: (organizationId) => ({ organizationId }) },
  { model: "salaryProfile", where: (organizationId) => ({ organizationId }) },
  { model: "payrollRun", where: (organizationId) => ({ organizationId }) },
  { model: "payrollItem", where: (organizationId) => ({ organizationId }) },
  { model: "payrollAdjustment", where: (organizationId) => ({ organizationId }) },
  { model: "salaryPayment", where: (organizationId) => ({ organizationId }) },
  { model: "salarySlip", where: (organizationId) => ({ organizationId }) },
  { model: "salaryAdvance", where: (organizationId) => ({ organizationId }) },
  { model: "advanceRecoveryEntry", where: (organizationId) => ({ advance: { organizationId } }) },
  { model: "reimbursementClaim", where: (organizationId) => ({ organizationId }) },
  { model: "reimbursementItem", where: (organizationId) => ({ claim: { organizationId } }) },

  // --- documents and communication
  { model: "employeeDocument", where: (organizationId) => ({ organizationId }) },
  { model: "documentVersion", where: (organizationId) => ({ document: { organizationId } }) },
  { model: "documentDeletionRequest", where: (organizationId) => ({ organizationId }) },
  { model: "letterTemplate", where: (organizationId) => ({ organizationId }) },
  { model: "letter", where: (organizationId) => ({ organizationId }) },
  { model: "announcement", where: (organizationId) => ({ organizationId }) },
  { model: "announcementComment", where: (organizationId) => ({ announcement: { organizationId } }) },

  // --- assets, onboarding, performance
  { model: "asset", where: (organizationId) => ({ organizationId }) },
  { model: "assetAssignment", where: (organizationId) => ({ organizationId }) },
  { model: "onboardingTemplate", where: (organizationId) => ({ organizationId }) },
  { model: "onboardingTemplateTask", where: (organizationId) => ({ template: { organizationId } }) },
  { model: "onboardingTask", where: (organizationId) => ({ organizationId }) },
  { model: "reviewCycle", where: (organizationId) => ({ organizationId }) },
  { model: "goal", where: (organizationId) => ({ organizationId }) },
  // Every update to how far along a goal got. In the export because the goal
  // itself only carries the latest figure, and the shape of the climb is the
  // part a review is written from.
  { model: "goalProgress", where: (organizationId) => ({ organizationId }) },
  { model: "performanceReview", where: (organizationId) => ({ organizationId }) },
  { model: "reviewRating", where: (organizationId) => ({ review: { organizationId } }) },
  { model: "trainingPlan", where: (organizationId) => ({ organizationId }) },

  // --- recognition
  //
  // The scores are in as well as the awards. An export that carried the winners
  // but not the figures they were computed from would lose the only thing that
  // makes a past result checkable.
  { model: "recognitionParameter", where: (organizationId) => ({ organizationId }) },
  { model: "recognitionCycle", where: (organizationId) => ({ organizationId }) },
  { model: "recognitionScore", where: (organizationId) => ({ cycle: { organizationId } }) },
  { model: "recognitionAward", where: (organizationId) => ({ organizationId }) },

  // --- exit
  { model: "exitRecord", where: (organizationId) => ({ organizationId }) },
  { model: "exitChecklistItem", where: (organizationId) => ({ exitRecord: { organizationId } }) },
  { model: "fnfSettlement", where: (organizationId) => ({ organizationId }) },
  { model: "fnfLine", where: (organizationId) => ({ settlement: { organizationId } }) },

  // --- billing
  { model: "subscription", where: (organizationId) => ({ organizationId }) },
  { model: "subscriptionHistory", where: (organizationId) => ({ organizationId }) },
  { model: "paymentOrder", where: (organizationId) => ({ organizationId }) },
];
