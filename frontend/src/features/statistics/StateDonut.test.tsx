import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { Metrics } from '../../api/client';
import { StateDonut } from './StateDonut';

const metrics: Metrics = {
  valid_duration_ms: 100000,
  normal_duration_ms: 60000,
  caution_duration_ms: 25000,
  high_duration_ms: 15000,
  forward_head_suspected_ms: 0,
  mean_display_angle_deg: 10,
  within_range_percent: 60,
  first_stage_alert_count: 0,
  corrected_alert_count: 0,
  unknown_correction_count: 0,
  mean_correction_ms: null,
};

afterEach(cleanup);

it('labels every slice with its share and time, and shows the normal share in the centre', () => {
  render(<StateDonut title="웹캠 · 테스트" metrics={metrics} />);
  expect(
    screen.getByRole('img', { name: /정상 60\.0%, 주의 25\.0%, 높음 15\.0%/ }),
  ).toBeInTheDocument();
  expect(screen.getAllByText('60.0%')).toHaveLength(2); // 가운데 + 범례
  expect(screen.getByText('25.0%')).toBeInTheDocument();
  expect(screen.getByText('0분 15초')).toBeInTheDocument();
});

it('switches the centre to the hovered state', () => {
  render(<StateDonut title="웹캠 · 테스트" metrics={metrics} />);
  fireEvent.mouseEnter(screen.getByText('주의').closest('li')!);
  expect(screen.getAllByText('25.0%')).toHaveLength(2);
});

it('does not draw an empty ring as data when there is no valid time', () => {
  render(
    <StateDonut
      title="웹캠 · 테스트"
      metrics={{
        ...metrics,
        valid_duration_ms: 0,
        normal_duration_ms: 0,
        caution_duration_ms: 0,
        high_duration_ms: 0,
      }}
    />,
  );
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('유효 측정 시간이 없어요.')).toBeInTheDocument();
});
