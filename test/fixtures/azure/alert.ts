import { ALERT_ID, ALERT_RULE_ARM_ID, CALLER_EMAIL, SUBSCRIPTION_ID, VM_ARM_ID } from './values.js';

/** A fired metric alert, as returned by `Microsoft.AlertsManagement/alerts`. */
export const FIRED_ALERT: unknown = {
  id: `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.AlertsManagement/alerts/${ALERT_ID}`,
  type: 'Microsoft.AlertsManagement/alerts',
  name: 'cpu-high',
  properties: {
    essentials: {
      severity: 'Sev2',
      signalType: 'Metric',
      alertState: 'New',
      monitorCondition: 'Fired',
      monitorService: 'Platform',
      targetResource: VM_ARM_ID,
      targetResourceName: 'vm-web-01',
      targetResourceGroup: 'rg-app',
      targetResourceType: 'virtualmachines',
      sourceCreatedId: ALERT_ID,
      smartGroupId: ALERT_ID,
      alertRule: ALERT_RULE_ARM_ID,
      startDateTime: '2026-11-03T08:12:00.000Z',
      lastModifiedDateTime: '2026-11-03T08:12:00.000Z',
      lastModifiedUserName: CALLER_EMAIL,
      actionStatus: { isSuppressed: false },
      description: 'CPU above 90% for 5 minutes',
    },
    context: {
      context: {
        conditionType: 'SingleResourceMultipleMetricCriteria',
        condition: {
          windowSize: 'PT5M',
          allOf: [
            {
              metricName: 'Percentage CPU',
              metricNamespace: 'Microsoft.Compute/virtualMachines',
              operator: 'GreaterThan',
              threshold: '90',
              timeAggregation: 'Average',
              metricValue: 97.4,
            },
          ],
        },
        resourceId: VM_ARM_ID,
        portalLink: `https://portal.azure.com/#resource${VM_ARM_ID}`,
      },
    },
  },
};
