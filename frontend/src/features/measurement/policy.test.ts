import { policy } from '@ecolephant/ai';
import { expect, it } from 'vitest';
import { checkPolicy } from './policy';

const server = {
  policy_id: policy.policy_id,
  revision: policy.revision,
  release_approved: false,
  supported_modes: ['webcam', 'airpods'] as ('webcam' | 'airpods' | 'combined')[],
  camera_mapping_status: 'unvalidated' as const,
};

it('accepts the built-in policy when the server lists the same revision and mode', () => {
  expect(checkPolicy([server], 'webcam')).toEqual({ status: 'ok', server });
});

it('blocks when the server does not list the built-in policy', () => {
  expect(checkPolicy([{ ...server, policy_id: 'other' }], 'webcam').status).toBe('blocked');
  expect(checkPolicy([], 'webcam').status).toBe('blocked');
});

it('blocks when the server revision differs', () => {
  const result = checkPolicy([{ ...server, revision: 'x' }], 'webcam');
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringContaining('버전') });
});

it('blocks modes the policy does not support', () => {
  expect(checkPolicy([server], 'combined')).toMatchObject({ status: 'blocked' });
});
