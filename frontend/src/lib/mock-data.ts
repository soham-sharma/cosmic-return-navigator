import type { ReturnReason, ProcessingStep } from './types';

export const RETURN_REASONS: { value: ReturnReason; label: string; description: string }[] = [
  {
    value: 'defective',
    label: 'Defective or broken',
    description: 'The item stopped working or arrived with a fault',
  },
  {
    value: 'wrong_item',
    label: 'Wrong item received',
    description: 'I received a different item than what I ordered',
  },
  {
    value: 'changed_mind',
    label: 'Changed my mind',
    description: 'I no longer need or want this item',
  },
  {
    value: 'damaged_in_transit',
    label: 'Damaged during shipping',
    description: 'The item was damaged when it arrived',
  },
  {
    value: 'not_as_described',
    label: 'Not as described',
    description: "The item doesn't match the listing or my expectations",
  },
  {
    value: 'other',
    label: 'Other reason',
    description: "Something else — I'll explain below",
  },
];

export const PROCESSING_STEPS: ProcessingStep[] = [
  {
    id: 'step-1',
    label: 'Verifying your order',
    detail: 'Checking order history and return eligibility',
    done: false,
  },
  {
    id: 'step-2',
    label: 'Reviewing return policy',
    detail: 'Confirming eligibility for your product and region',
    done: false,
  },
  {
    id: 'step-3',
    label: 'Finding the best resolution',
    detail: 'Selecting the optimal outcome for your situation',
    done: false,
  },
  {
    id: 'step-4',
    label: 'Arranging logistics',
    detail: 'Preparing your return label and scheduling collection',
    done: false,
  },
  {
    id: 'step-5',
    label: 'Finalising your return',
    detail: 'Sending confirmation and updating your account',
    done: false,
  },
];
