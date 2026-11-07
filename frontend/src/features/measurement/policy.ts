import { useQuery } from '@tanstack/react-query';
import { policy } from '@ecolephant/ai';
import type { Mode } from '@ecolephant/ai';
import { api, errorMessage } from '../../api/client';
import type { components } from '../../api/generated';

type PolicySummary = components['schemas']['PolicySummary'];

export type PolicyCheck =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | { status: 'blocked'; message: string }
  | { status: 'ok'; server: PolicySummary };

/** 브라우저에 내장된 분석 정책이 서버 정책 목록과 일치하는지, 선택한 측정 방식을 허용하는지 확인합니다. */
export function checkPolicy(items: PolicySummary[], mode: Mode): PolicyCheck {
  const label = `${policy.policy_id} (${policy.revision})`;
  const server = items.find((item) => item.policy_id === policy.policy_id);
  if (!server)
    return { status: 'blocked', message: `서버에 정책 ${label}이 없어 측정을 시작할 수 없습니다.` };
  if (server.revision !== policy.revision)
    return {
      status: 'blocked',
      message: `서버 정책 버전(${server.revision})이 앱 정책 ${label}과 달라 측정을 시작할 수 없습니다.`,
    };
  if (!server.supported_modes.includes(mode))
    return { status: 'blocked', message: '이 정책은 선택한 측정 방식을 지원하지 않습니다.' };
  return { status: 'ok', server };
}

export function usePolicyCheck(mode: Mode): PolicyCheck {
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api.policies(),
    staleTime: 5 * 60 * 1000,
  });
  if (policies.isPending) return { status: 'loading' };
  if (policies.isError)
    return {
      status: 'error',
      message: errorMessage(policies.error),
      retry: () => void policies.refetch(),
    };
  return checkPolicy(policies.data.items, mode);
}
