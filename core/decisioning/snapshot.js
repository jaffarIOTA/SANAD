function programmeHeadroomMinorUnits(s) {
  const headroom = s.programme.programmeLimitMinorUnits - s.programme.programmeUtilisedMinorUnits;
  return headroom > 0n ? headroom : 0n;
}
function aggregateExposureMinorUnits(s) {
  return s.exposure.platformExposureMinorUnits + s.exposure.coreBankingExposureMinorUnits + s.exposure.groupExposureMinorUnits;
}
export {
  aggregateExposureMinorUnits,
  programmeHeadroomMinorUnits
};
