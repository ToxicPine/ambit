# =============================================================================
# Chromatic CDP - Chrome DevTools Protocol Container
# =============================================================================

FROM zenika/alpine-chrome:124

COPY start.sh /start.sh

USER root
RUN chmod +x /start.sh

USER chrome

ENTRYPOINT []
CMD ["/start.sh"]
