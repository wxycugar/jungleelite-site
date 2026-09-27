import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sanity from '@sanity/astro';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://jungleelite.com',

  // 全站维持静态预渲染，只有 /api/* 这类显式声明 `prerender = false` 的路由
  // 才会被编译成 Vercel Function。营销页面的性能与 CDN 行为完全不受影响。
  output: 'static',
  adapter: vercel(),

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
    sitemap(),
  ],
});
