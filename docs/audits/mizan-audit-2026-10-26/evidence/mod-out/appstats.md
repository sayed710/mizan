| app id | menu models | pages | fields | computes | run/vals/server btns | business guards | company-only guards | protectDelete | models reachable (modelsForApps) | tests (neg / applyDiff-or-HTTP) | top test files |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spreadsheet | 1 | spreadsheet | 5 | 0 | 1/0/0 | 0 | 0 | 0 | 14 | 0 (0/0) | - |
| discuss | 1 | discuss | 11 | 1 | 2/0/0 | 0 | 0 | 0 | 13 | 2 (0/0) | csv.test.js(1) documentsplus.test.js(1) |
| calendar | 1 | - | 7 | 0 | 0/0/0 | 0 | 0 | 0 | 14 | 2 (1/0) | appointments.test.js(1) recruitplus.test.js(1) |
| appointments | 2 | - | 31 | 2 | 1/2/0 | 1 | 0 | 0 | 16 | 13 (9/0) | appointments.test.js(7) server/appointments.test.js(2) server/public-forms.test.js(2) events.test.js(1) |
| todo | 1 | - | 6 | 0 | 0/0/0 | 0 | 0 | 0 | 14 | 0 (0/0) | - |
| knowledge | 1 | knowledge | 16 | 0 | 0/0/0 | 1 | 0 | 0 | 14 | 8 (3/0) | knowledge.test.js(8) |
| contacts | 1 | - | 16 | 0 | 1/0/1 | 0 | 0 | 0 | 13 | 37 (16/4) | whatsapp.test.js(5) company.test.js(3) appointments.test.js(2) eventsplus.test.js(2) |
| crm | 4 | - | 90 | 6 | 16/4/3 | 1 | 1 | 0 | 22 | 77 (24/10) | orm.test.js(11) server/portal.test.js(8) company.test.js(7) quoteplus.test.js(7) |
| sales | 8 | - | 135 | 6 | 16/2/4 | 5 | 0 | 0 | 22 | 65 (27/2) | server/portal.test.js(8) quoteplus.test.js(7) company.test.js(6) loyalty.test.js(6) |
| dashboards | 0 | overview | 0 | 0 | 0/0/0 | 0 | 0 | 0 | 13 | 0 (0/0) | - |
| subscriptions | 2 | - | 31 | 2 | 4/4/0 | 1 | 0 | 0 | 17 | 11 (3/0) | subscriptionplus.test.js(9) more.test.js(1) subscription.test.js(1) |
| rental | 3 | - | 26 | 2 | 6/1/0 | 1 | 0 | 0 | 17 | 10 (3/0) | rentalplus.test.js(4) rental.test.js(2) review-fixes2.test.js(2) extra.test.js(1) |
| pos | 4 | pos | 43 | 3 | 4/0/0 | 1 | 0 | 0 | 19 | 16 (9/0) | posplus.test.js(10) valuation-wiring.test.js(3) apps3.test.js(1) pos.test.js(1) |
| kitchen | 0 | kitchen | 0 | 0 | 0/0/0 | 0 | 0 | 0 | 13 | 0 (0/0) | - |
| accounting | 23 | dashboard,report,report,report,report,report,report,report,report,report,report,report,report,report,report,report,report | 223 | 13 | 41/6/2 | 5 | 2 | 3 | 36 | 154 (59/3) | closing.test.js(10) analyticplus.test.js(8) loans.test.js(7) billcontrol.test.js(6) |
| documents | 5 | - | 41 | 1 | 6/0/0 | 2 | 0 | 0 | 18 | 14 (11/0) | documentsplus.test.js(7) signplus.test.js(6) events.test.js(1) |
| project | 5 | - | 48 | 0 | 1/1/0 | 1 | 1 | 0 | 18 | 8 (4/0) | projectplus.test.js(6) company.test.js(1) onchange.test.js(1) |
| timesheets | 1 | - | 21 | 0 | 4/0/0 | 1 | 0 | 0 | 19 | 10 (5/0) | timesheetplus.test.js(5) analyticplus.test.js(4) analytic-wiring.test.js(1) |
| planning | 2 | - | 29 | 1 | 6/0/0 | 1 | 0 | 0 | 17 | 8 (3/0) | planningplus.test.js(7) events.test.js(1) |
| helpdesk | 3 | - | 35 | 1 | 4/0/0 | 0 | 1 | 0 | 17 | 14 (6/1) | helpdesk.test.js(8) review-fixes3.test.js(2) company.test.js(1) fsm.test.js(1) |
| website | 12 | website | 150 | 6 | 19/9/2 | 5 | 0 | 0 | 29 | 73 (32/2) | websiteplus.test.js(9) server/portal.test.js(8) quoteplus.test.js(7) company.test.js(6) |
| marketing | 5 | - | 53 | 5 | 2/2/0 | 1 | 0 | 0 | 18 | 15 (5/1) | mailing.test.js(7) server/mailtrack.test.js(3) extra.test.js(2) sms.test.js(2) |
| events | 6 | - | 49 | 0 | 4/1/0 | 1 | 0 | 0 | 20 | 9 (5/1) | eventsplus.test.js(6) events.test.js(1) review-fixes2.test.js(1) server/public-forms.test.js(1) |
| purchase | 5 | - | 93 | 4 | 11/3/1 | 1 | 1 | 0 | 18 | 29 (11/2) | billcontrol.test.js(7) purchaseplus.test.js(7) company.test.js(3) routes.test.js(3) |
| inventory | 15 | report | 152 | 2 | 15/0/0 | 4 | 1 | 2 | 30 | 59 (28/0) | valuation-wiring.test.js(7) warehouse.test.js(7) batch.test.js(6) picking.test.js(6) |
| manufacturing | 7 | - | 107 | 1 | 14/2/0 | 1 | 0 | 0 | 21 | 21 (12/0) | workorder.test.js(8) valuation-wiring.test.js(4) mrp.test.js(3) more.test.js(2) |
| shopfloor | 0 | shopfloor | 0 | 0 | 0/0/0 | 0 | 0 | 0 | 13 | 0 (0/0) | - |
| barcode | 0 | barcode | 0 | 0 | 0/0/0 | 0 | 0 | 0 | 13 | 0 (0/0) | - |
| quality | 3 | - | 37 | 0 | 3/2/0 | 0 | 0 | 0 | 18 | 9 (1/0) | qualityplus.test.js(7) apps2.test.js(1) picking.test.js(1) |
| maintenance | 2 | - | 29 | 0 | 3/0/0 | 2 | 0 | 0 | 15 | 9 (3/4) | maintplus.test.js(8) subscription.test.js(1) |
| repairs | 1 | - | 26 | 3 | 6/1/0 | 0 | 0 | 0 | 19 | 7 (3/0) | repairplus.test.js(6) apps2.test.js(1) |
| fieldservice | 1 | - | 21 | 2 | 6/0/0 | 0 | 0 | 0 | 17 | 7 (4/0) | fsm.test.js(5) helpdesk.test.js(1) review-fixes3.test.js(1) |
| sign | 2 | - | 25 | 1 | 5/1/0 | 0 | 0 | 0 | 16 | 8 (3/0) | signplus.test.js(5) documentsplus.test.js(1) events.test.js(1) extra.test.js(1) |
| employees | 2 | - | 42 | 0 | 0/0/0 | 0 | 1 | 0 | 14 | 25 (13/1) | planningplus.test.js(4) expenseplus.test.js(3) timesheetplus.test.js(3) appraisalplus.test.js(2) |
| attendances | 2 | kiosk | 21 | 3 | 2/0/0 | 2 | 0 | 0 | 15 | 13 (7/0) | attendanceplus.test.js(10) payroll.test.js(2) review-fixes3.test.js(1) |
| recruitment | 2 | - | 34 | 0 | 5/1/0 | 0 | 0 | 0 | 16 | 9 (6/0) | recruitplus.test.js(4) skillsplus.test.js(3) recruitment.test.js(1) review-fixes3.test.js(1) |
| timeoff | 2 | - | 16 | 1 | 1/4/0 | 1 | 0 | 0 | 15 | 12 (2/3) | approvalsplus.test.js(2) attendanceplus.test.js(2) payroll.test.js(2) timeoff.test.js(2) |
| appraisals | 3 | - | 29 | 4 | 6/0/0 | 2 | 0 | 0 | 16 | 9 (9/0) | appraisalplus.test.js(9) |
| payroll | 5 | - | 31 | 3 | 8/1/0 | 0 | 0 | 0 | 18 | 6 (1/1) | payroll.test.js(5) security.test.js(1) |
| expenses | 2 | - | 33 | 1 | 9/4/0 | 1 | 0 | 2 | 18 | 15 (8/0) | expenseplus.test.js(11) expense.test.js(3) documentsplus.test.js(1) |
| fleet | 5 | - | 48 | 1 | 4/0/0 | 2 | 0 | 0 | 18 | 7 (4/0) | fleetplus.test.js(5) review-fixes3.test.js(1) subscription.test.js(1) |
| lunch | 5 | - | 50 | 1 | 4/0/0 | 2 | 0 | 0 | 18 | 8 (3/0) | lunch.test.js(8) |
| approvals | 2 | - | 24 | 1 | 5/0/0 | 0 | 0 | 0 | 15 | 6 (4/4) | approvalsplus.test.js(5) review-fixes4.test.js(1) |
| frontdesk | 2 | - | 28 | 1 | 4/0/0 | 1 | 0 | 0 | 15 | 7 (5/0) | frontdeskplus.test.js(7) |
| surveys | 2 | surveytake,surveyresults | 23 | 1 | 2/2/0 | 0 | 0 | 0 | 15 | 2 (1/0) | surveys.test.js(2) |
| elearning | 2 | - | 25 | 2 | 3/2/0 | 1 | 0 | 0 | 15 | 9 (7/0) | elearning.test.js(9) |
| livechat | 4 | - | 34 | 5 | 2/0/0 | 0 | 0 | 0 | 17 | 8 (6/0) | livechat.test.js(6) server/livechat.test.js(2) |
| whatsapp | 2 | - | 20 | 0 | 1/4/1 | 1 | 0 | 0 | 15 | 7 (4/2) | whatsapp.test.js(5) server/whatsapp.test.js(2) |
| sms | 3 | - | 25 | 3 | 1/2/1 | 0 | 0 | 0 | 17 | 4 (1/0) | sms.test.js(3) apps3.test.js(1) |
| social | 2 | - | 19 | 5 | 2/1/0 | 0 | 0 | 0 | 15 | 3 (2/0) | social.test.js(3) |
| automation | 2 | - | 12 | 0 | 3/1/0 | 0 | 0 | 0 | 16 | 3 (0/0) | automation.test.js(3) |
| plm | 2 | - | 12 | 0 | 0/0/0 | 0 | 0 | 0 | 16 | 7 (2/0) | valuation-wiring.test.js(3) review-fixes2.test.js(1) routes.test.js(1) uom-flows.test.js(1) |
| rooms | 2 | - | 10 | 0 | 0/0/0 | 0 | 0 | 0 | 15 | 0 (0/0) | - |
| referral | 2 | - | 15 | 3 | 0/0/0 | 2 | 0 | 0 | 17 | 5 (4/0) | skillsplus.test.js(5) |
| skills | 4 | - | 19 | 1 | 0/0/0 | 3 | 0 | 0 | 17 | 3 (2/0) | skillsplus.test.js(3) |
| esg | 1 | - | 7 | 1 | 1/0/0 | 0 | 0 | 0 | 14 | 1 (0/0) | apps3.test.js(1) |
| equity | 1 | captable | 10 | 1 | 1/0/0 | 0 | 0 | 0 | 14 | 0 (0/0) | - |
| recycle | 1 | - | 6 | 0 | 2/0/0 | 0 | 0 | 0 | 14 | 0 (0/0) | - |
| phone | 1 | - | 7 | 0 | 1/0/0 | 0 | 0 | 0 | 14 | 0 (0/0) | - |
| iot | 1 | - | 7 | 0 | 1/0/1 | 0 | 0 | 0 | 14 | 1 (1/0) | server/integrations.test.js(1) |
| studio | 0 | studio | 0 | 0 | 0/0/0 | 0 | 0 | 0 | 13 | 0 (0/0) | - |
| apps | 0 | appstore | 0 | 0 | 0/0/0 | 0 | 0 | 0 | 13 | 0 (0/0) | - |
| settings | 1 | settings | 13 | 0 | 0/0/0 | 1 | 0 | 0 | 14 | 8 (3/0) | company.test.js(7) consolidation.test.js(1) |
