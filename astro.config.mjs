import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sanity from '@sanity/astro';

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    sanity({
      projectId: 'mvlp34xo',
      dataset: 'production',
      useCdn: false, // 设为 false，确保你后台一发布，前台立马更新
      apiVersion: '2026-04-04', // 锁定今天的 API 版本
    }),
  ],
});