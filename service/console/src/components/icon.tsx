/** 线条小图标：一条路径，圆头细线，颜色跟文字走。 */
export const Icon = (props: { readonly d: string }) => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={props.d} /></svg>
);

export const CHEVRON = 'M6 9l6 6 6-6';
export const SEARCH = 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM20 20l-3.5-3.5';
export const PLUS = 'M12 5v14M5 12h14';
export const MINUS = 'M5 12h14';
export const FIT = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
export const CLOCK = 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2';
export const PUBLISH = 'M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14';
export const CHECK = 'M5 12.5l4.5 4.5L19 7.5';
export const ALERT = 'M12 6v8M12 18.5v.01';
export const CROSS = 'M7 7l10 10M17 7L7 17';
export const COPY = 'M9 8h11v12H9zM5 16V4h11';
export const TRASH = 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5';
