'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { TrendingUp } from 'lucide-react';
import type { EChartsOption } from 'echarts';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

export interface TrendPoint {
  date: string;
  groups: number;
  private: number;
}

export default function TrendChart({ data }: { data: TrendPoint[] }) {
  const totals = data.reduce(
    (sum, point) => ({ groups: sum.groups + point.groups, private: sum.private + point.private }),
    { groups: 0, private: 0 },
  );
  const option = useMemo<EChartsOption>(
    () => ({
      animationDuration: 280,
      grid: { top: 42, right: 22, bottom: 30, left: 50 },
      legend: {
        top: 4,
        right: 8,
        itemWidth: 10,
        itemHeight: 6,
        textStyle: { color: '#6C7680', fontSize: 11 },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#15181C',
        borderColor: '#272C31',
        textStyle: { color: '#F4F6F8' },
      },
      xAxis: {
        type: 'category',
        data: data.map((point) => point.date.slice(5)),
        axisLine: { lineStyle: { color: '#C8CFD6' } },
        axisTick: { show: false },
        axisLabel: { color: '#6C7680', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: 'rgba(200,207,214,0.55)' } },
        axisLabel: { color: '#6C7680', fontSize: 10 },
      },
      series: [
        {
          name: '群聊',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: data.map((point) => point.groups),
          lineStyle: { color: '#1F566B', width: 2 },
          areaStyle: { color: 'rgba(31,86,107,0.10)' },
        },
        {
          name: '私信',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: data.map((point) => point.private),
          lineStyle: { color: '#8E3B46', width: 2 },
          areaStyle: { color: 'rgba(142,59,70,0.07)' },
        },
      ],
    }),
    [data],
  );

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[15px] font-semibold">
          <TrendingUp size={14} className="text-[var(--accent)]" />
          消息趋势
        </div>
        <div className="text-[12px] text-[var(--text-3)]">
          群聊 {totals.groups.toLocaleString()} · 私信 {totals.private.toLocaleString()}
        </div>
      </div>
      {data.some((point) => point.groups + point.private > 0) ? (
        <ReactECharts option={option} style={{ height: 290 }} />
      ) : (
        <div className="flex h-[290px] items-center justify-center text-[13px] text-[var(--text-3)]">
          还没有本地消息快照
        </div>
      )}
    </section>
  );
}
