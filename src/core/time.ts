import moment from "moment";

/** 以青龙常用的北京时间格式输出时间。 */
export function formatTime(value: moment.MomentInput = undefined): string {
  return moment(value).format("YYYY-MM-DD HH:mm:ss");
}

export { moment };
